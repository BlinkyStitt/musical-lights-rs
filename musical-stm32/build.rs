fn main() {
    firmware_revision();
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    std::fs::write(out.join("memory.x"), include_bytes!("memory.x")).expect("memory layout");
    println!("cargo:rustc-link-search={}", out.display());
    println!("cargo:rerun-if-changed=memory.x");
    println!("cargo:rustc-link-arg-bins=--nmagic");
    println!("cargo:rustc-link-arg-bins=-Tlink.x");
    println!("cargo:rustc-link-arg-bins=-Tdefmt.x");
}

fn firmware_revision() {
    let revision = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .expect("git revision");
    assert!(
        revision.status.success(),
        "firmware build requires a source revision"
    );
    let revision = std::str::from_utf8(&revision.stdout)
        .expect("revision UTF-8")
        .trim();
    println!("cargo:rustc-env=FIRMWARE_REVISION={revision}");
    for name in [
        "HEAD".to_string(),
        std::process::Command::new("git")
            .args(["symbolic-ref", "-q", "HEAD"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default()
            .trim()
            .to_string(),
    ] {
        if name.is_empty() {
            continue;
        }
        let path = std::process::Command::new("git")
            .args(["rev-parse", "--git-path", &name])
            .output()
            .expect("git metadata path");
        println!(
            "cargo:rerun-if-changed={}",
            std::str::from_utf8(&path.stdout).unwrap().trim()
        );
    }
}
