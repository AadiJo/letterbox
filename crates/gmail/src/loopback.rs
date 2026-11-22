//! The tiny HTTP server that catches the browser's redirect after consent. It answers
//! every request it gets, and stops at the first one that carries this attempt's
//! `state` with either a `code` or an `error`.

use std::io;
#[cfg(unix)]
use std::path::PathBuf;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
#[cfg(unix)]
use tokio::net::UnixListener;

use crate::config::Loopback;

/// What the redirect said.
pub enum Redirect {
    Code(String),
    /// `error=access_denied` means the user declined. Any other error is treated the same:
    /// the user did not end up granting access.
    Refused,
}

/// A listener waiting for one redirect. Dropping it stops listening.
pub struct Listening {
    pub redirect_uri: String,
    listener: Listener,
}

enum Listener {
    Tcp(TcpListener),
    #[cfg(unix)]
    Unix(UnixListener, PathBuf),
}

impl Drop for Listener {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Listener::Unix(_, path) = self {
            // A socket file left behind would only block the next bind, which removes it anyway.
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Starts listening. `attempt` counts sign-in attempts, from 0, and picks the port for `Loopback::Unix`.
pub async fn listen(
    loopback: &Loopback,
    #[cfg_attr(
        not(unix),
        expect(unused_variables, reason = "only Loopback::Unix, which is unix only, reads it")
    )]
    attempt: u16,
) -> io::Result<Listening> {
    match loopback {
        Loopback::Tcp => {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
            let port = listener.local_addr()?.port();
            Ok(Listening {
                redirect_uri: format!("http://127.0.0.1:{port}"),
                listener: Listener::Tcp(listener),
            })
        }
        #[cfg(unix)]
        Loopback::Unix { dir, first_port } => {
            let port = first_port.wrapping_add(attempt);
            let path = dir.join(format!("{port}.sock"));
            // An attempt that was cancelled may not have released its socket yet. Take its place.
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path)?;
            Ok(Listening {
                redirect_uri: format!("http://127.0.0.1:{port}"),
                listener: Listener::Unix(listener, path),
            })
        }
    }
}

impl Listening {
    /// Waits for the redirect that carries `state`. Err only if the listener itself fails.
    pub async fn redirect(&self, state: &str) -> io::Result<Redirect> {
        loop {
            let found = match &self.listener {
                Listener::Tcp(listener) => answer(listener.accept().await?.0, state).await,
                #[cfg(unix)]
                Listener::Unix(listener, _) => answer(listener.accept().await?.0, state).await,
            };
            if let Some(redirect) = found {
                return Ok(redirect);
            }
        }
    }
}

/// The page the browser shows once the redirect lands.
const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Signed in</title>\
                         <p>You can close this window and go back to Letterbox.";

/// Reads one request, answers it, and returns what it said if it is the redirect for `state`.
/// A request that breaks off or is not the redirect (a favicon, a stale tab) gets nothing back.
async fn answer<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, state: &str) -> Option<Redirect> {
    let target = request_target(&mut stream).await?;
    let found = redirect_in(&target, state);
    let (status, body) = match found {
        Some(_) => ("200 OK", DONE_PAGE),
        None => ("404 Not Found", ""),
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: \
         close\r\n\r\n{body}",
        body.len()
    );
    // The browser may already have gone. The redirect still counts.
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
    found
}

/// The target of the request line, such as `/?code=...&state=...`. Reads until the end of
/// the headers, at most 16 KiB.
async fn request_target<S: AsyncRead + Unpin>(stream: &mut S) -> Option<String> {
    let mut head = Vec::new();
    let mut chunk = [0; 1024];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 || head.len() > 16 * 1024 {
            return None;
        }
        head.extend_from_slice(&chunk[..read]);
    }
    let head = String::from_utf8_lossy(&head);
    let mut words = head.lines().next()?.split(' ');
    (words.next()? == "GET").then_some(())?;
    words.next().map(str::to_owned)
}

/// Reads a redirect out of a request target. None unless it carries `state` and a code or an error.
fn redirect_in(target: &str, state: &str) -> Option<Redirect> {
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    let mut code = None;
    let mut error = None;
    let mut matched = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "state" => matched = value == state,
            "code" => code = Some(value.into_owned()),
            "error" => error = Some(()),
            _ => {}
        }
    }
    if !matched {
        return None;
    }
    match (code, error) {
        (_, Some(())) => Some(Redirect::Refused),
        (Some(code), None) => Some(Redirect::Code(code)),
        (None, None) => None,
    }
}
