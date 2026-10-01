use serde::{Deserialize, Serialize};

pub const MAX_AUDIO_BYTES: usize = 512 * 1024;

pub fn audio_extension(content_type: &str) -> Option<&'static str> {
    match content_type.split(';').next()?.trim() {
        "audio/webm" => Some("webm"),
        "audio/mp4" => Some("m4a"),
        "audio/ogg" => Some("ogg"),
        "audio/wav" => Some("wav"),
        _ => None,
    }
}

#[derive(Deserialize)]
pub struct AudDResponse {
    pub status: String,
    pub result: Option<Song>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct Song {
    pub artist: String,
    pub title: String,
    #[serde(default)]
    pub album: String,
}

impl Song {
    pub fn valid(&self) -> bool {
        [&self.artist, &self.title]
            .iter()
            .all(|s| !s.trim().is_empty() && s.len() <= 1000)
            && self.album.len() <= 1000
    }
}

#[derive(Serialize)]
pub struct Recognition {
    pub result: Option<Song>,
}

#[cfg(target_arch = "wasm32")]
mod edge;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_browser_recordings_only() {
        assert_eq!(audio_extension("audio/webm;codecs=opus"), Some("webm"));
        assert_eq!(audio_extension("audio/mp4; codecs=mp4a.40.2"), Some("m4a"));
        for rejected in [
            "text/html",
            "application/json",
            "multipart/form-data",
            "",
            "audio/mp3",
        ] {
            assert_eq!(audio_extension(rejected), None);
        }
    }

    #[test]
    fn incomplete_or_excessive_metadata_is_not_a_match() {
        let mut song = Song {
            artist: "Artist".into(),
            title: "Title".into(),
            album: String::new(),
        };
        assert!(song.valid());
        song.title = " ".into();
        assert!(!song.valid());
        song.title = "x".repeat(1001);
        assert!(!song.valid());
    }
}
