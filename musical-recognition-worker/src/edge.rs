use crate::{AudDResponse, MAX_AUDIO_BYTES, Recognition, audio_extension};
use futures_util::{
    StreamExt,
    future::{Either, select},
};
use serde::Serialize;
use std::time::Duration;
use worker::*;

#[derive(Serialize)]
struct Failure<'a> {
    error: &'a str,
}

fn failure(status: u16, message: &str) -> Result<Response> {
    Ok(Response::from_json(&Failure { error: message })?.with_status(status))
}

#[event(fetch)]
pub async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let origin = req.headers().get("Origin")?.unwrap_or_default();
    let allowed = env.var("ALLOWED_ORIGINS")?.to_string();
    if origin.is_empty() || !allowed.split(',').any(|entry| entry.trim() == origin) {
        return failure(403, "Origin not allowed.");
    }
    // Never return provider errors, credentials, or audio in responses/logs.
    let mut response = match recognize(&mut req, &env).await {
        Ok(response) => response,
        Err(_) => failure(502, "Recognition is unavailable. Try again later.")?,
    };
    let headers = response.headers_mut();
    headers.set("Access-Control-Allow-Origin", &origin)?;
    headers.set("Vary", "Origin")?;
    headers.set("Cache-Control", "no-store")?;
    headers.set("X-Content-Type-Options", "nosniff")?;
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS")?;
    headers.set("Access-Control-Allow-Headers", "Content-Type")?;
    if response.status_code() == 429 {
        response.headers_mut().set("Retry-After", "60")?;
    }
    Ok(response)
}

async fn recognize(req: &mut Request, env: &Env) -> Result<Response> {
    if req.path() != "/recognize" {
        return failure(404, "Not found.");
    }
    if req.method() == Method::Options {
        return Ok(Response::empty()?.with_status(204));
    }
    if req.method() != Method::Post {
        return failure(405, "Use POST.");
    }
    let content_type = req.headers().get("Content-Type")?.unwrap_or_default();
    let Some(extension) = audio_extension(&content_type) else {
        return failure(415, "Unsupported audio format.");
    };
    if req
        .headers()
        .get("Content-Length")?
        .and_then(|n| n.parse::<usize>().ok())
        .is_some_and(|n| n > MAX_AUDIO_BYTES)
    {
        return failure(413, "Audio sample is too large.");
    }
    let token = match env.secret("AUDD_API_TOKEN") {
        Ok(token) if !token.to_string().trim().is_empty() => token.to_string(),
        _ => return failure(503, "Song recognition is not configured yet."),
    };
    let ip = req
        .headers()
        .get("CF-Connecting-IP")?
        .unwrap_or_else(|| "unknown".into());
    if !env.rate_limiter("PER_IP")?.limit(ip).await?.success
        || !env
            .rate_limiter("TOTAL")?
            .limit("recognition".into())
            .await?
            .success
    {
        return failure(
            429,
            "Too many requests. Wait a minute before identifying again.",
        );
    }
    let mut bytes = Vec::new();
    let mut body = req.stream()?;
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > MAX_AUDIO_BYTES {
            return failure(413, "Audio sample is too large.");
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return failure(400, "Audio sample is empty.");
    }
    let data = js_sys::Uint8Array::from(bytes.as_slice());
    let file = web_sys::File::new_with_u8_array_sequence(
        &js_sys::Array::of1(&data),
        &format!("sample.{extension}"),
    )?;
    let form = web_sys::FormData::new()?;
    form.append_with_str("api_token", &token)?;
    form.append_with_blob_and_filename("file", &file, &format!("sample.{extension}"))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_body(Some(form.into()));
    let upstream = Fetch::Request(Request::new_with_init("https://api.audd.io/", &init)?);
    let abort = AbortController::default();
    let signal = abort.signal();
    let lookup = async {
        let mut response = upstream.send_with_signal(&signal).await?;
        if response.status_code() != 200 {
            return failure(502, "Recognition service is unavailable. Try again later.");
        }
        // Use the SDK's JSON boundary, backed by its existing serde_json parser.
        let reply: AudDResponse = response.json().await?;
        if reply.status != "success" || reply.result.as_ref().is_some_and(|song| !song.valid()) {
            return failure(502, "Recognition service could not process this sample.");
        }
        Response::from_json(&Recognition {
            result: reply.result,
        })
    };
    match select(
        Box::pin(lookup),
        Box::pin(Delay::from(Duration::from_secs(20))),
    )
    .await
    {
        Either::Left((response, _)) => response,
        Either::Right(_) => {
            abort.abort();
            failure(504, "Recognition timed out. Try again when ready.")
        }
    }
}
