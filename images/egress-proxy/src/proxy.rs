//! The TCP server. All policy decisions are delegated to the pure modules;
//! this file only sequences I/O:
//!
//! 1. accept (bounded by a semaphore),
//! 2. read exactly one request head (bounded in size and time),
//! 3. decide (parse → allowlist → resolve → classify),
//! 4. connect to the validated address, answer `200`, and copy raw bytes
//!    both ways until EOF, error, idle timeout, or shutdown.
//!
//! Nothing from the request head is ever forwarded upstream.

use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};
use tokio::time::{sleep, sleep_until, timeout, timeout_at, Instant};

use crate::config::Config;
use crate::ipclass::blocked_reason;
use crate::log::{LogSink, Record};
use crate::request::{find_head_end, parse_head, Rejection, Request, MAX_HEAD_BYTES};

/// Time allowed for writing one of our own (tiny) responses.
const RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// After an error response, how long we keep discarding client bytes so the
/// close is a clean FIN rather than an RST that could eat the response.
const DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const DRAIN_MAX_BYTES: usize = 64 * 1024;
/// Upper bound on resolved addresses tried for one CONNECT.
const MAX_CONNECT_ATTEMPTS: usize = 8;
/// Per-direction copy buffer.
const COPY_BUF_BYTES: usize = 16 * 1024;
/// After the grace period, how long to wait for tunnels to log their `close`.
const FORCE_CLOSE_WAIT: Duration = Duration::from_secs(2);

const RESP_ESTABLISHED: &[u8] = b"HTTP/1.1 200 Connection Established\r\n\r\n";

/// Boxed future returned by [`Resolver::resolve`].
pub type ResolveFuture<'a> = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send + 'a>>;

/// Name resolution, injectable so tests can simulate DNS rebinding.
pub trait Resolver: Send + Sync + 'static {
    /// Resolve `host` (already normalised, never an IP literal) to candidate
    /// addresses. Called at most once per CONNECT; the proxy connects only to
    /// addresses returned by that single call.
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a>;
}

/// The operating system resolver (`getaddrinfo` on a blocking thread).
#[derive(Debug, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a> {
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host, port)).await?;
            Ok(addrs.map(|a| a.ip()).collect())
        })
    }
}

struct Ctx {
    cfg: Config,
    resolver: Arc<dyn Resolver>,
    log: Arc<dyn LogSink>,
}

impl Ctx {
    /// Start a record carrying the fields every per-connection line has.
    fn event(&self, action: &str, host: &str, port: u16, client: SocketAddr) -> Record {
        Record::new(action)
            .str("host", host)
            .num("port", u64::from(port))
            .str("client", &client.to_string())
    }

    fn emit(&self, record: Record) {
        self.log.emit(record.finish());
    }
}

/// The proxy server.
pub struct Server {
    ctx: Arc<Ctx>,
}

impl Server {
    pub fn new(cfg: Config, resolver: Arc<dyn Resolver>, log: Arc<dyn LogSink>) -> Self {
        Self {
            ctx: Arc::new(Ctx { cfg, resolver, log }),
        }
    }

    /// The startup log line: effective allowlist and limits.
    pub fn startup_record(&self, listen: SocketAddr) -> String {
        let c = &self.ctx.cfg;
        Record::new("start")
            .str("listen", &listen.to_string())
            .str_array("allow", &c.allowlist.entries())
            .boolean("allow_private_upstreams", c.allow_private_upstreams)
            .num("max_conns", c.max_conns as u64)
            .num("header_timeout_ms", millis(c.header_timeout))
            .num("connect_timeout_ms", millis(c.connect_timeout))
            .num("idle_timeout_ms", millis(c.idle_timeout))
            .str("version", env!("CARGO_PKG_VERSION"))
            .finish()
    }

    /// Serve on `listener` until `shutdown` resolves, then stop accepting,
    /// give open connections `shutdown_grace` to finish, and force-close the
    /// rest.
    pub async fn run<F>(self, listener: TcpListener, shutdown: F)
    where
        F: Future<Output = ()>,
    {
        let ctx = self.ctx;
        let max = ctx.cfg.max_conns;
        let slots = Arc::new(Semaphore::new(max));
        let (force_tx, force_rx) = watch::channel(false);
        tokio::pin!(shutdown);

        loop {
            tokio::select! {
                () = &mut shutdown => break,
                accepted = listener.accept() => match accepted {
                    Ok((stream, peer)) => match Arc::clone(&slots).try_acquire_owned() {
                        Ok(permit) => {
                            tokio::spawn(handle_connection(
                                Arc::clone(&ctx),
                                stream,
                                peer,
                                force_rx.clone(),
                                permit,
                            ));
                        }
                        Err(_) => reject_over_capacity(&ctx, stream, peer),
                    },
                    Err(e) => {
                        ctx.emit(
                            Record::new("error")
                                .str("reason", "accept_failed")
                                .str("detail", &e.to_string()),
                        );
                        // Typically EMFILE/ENFILE; do not spin.
                        sleep(Duration::from_millis(50)).await;
                    }
                },
            }
        }

        drop(listener);
        ctx.emit(Record::new("shutdown").str("reason", "signal"));
        let all = u32::try_from(max).unwrap_or(u32::MAX);
        if timeout(ctx.cfg.shutdown_grace, slots.acquire_many(all))
            .await
            .is_err()
        {
            let _ = force_tx.send(true);
            let _ = timeout(FORCE_CLOSE_WAIT, slots.acquire_many(all)).await;
        }
        ctx.emit(Record::new("stopped"));
    }
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// At capacity: answer `503` without ever awaiting on the client, then drop.
fn reject_over_capacity(ctx: &Ctx, stream: TcpStream, peer: SocketAddr) {
    use std::io::Write as _;
    let body = "egress proxy at connection limit\n";
    // A single non-blocking write on the raw socket: a freshly accepted
    // connection always has send-buffer room for this, and if it somehow does
    // not, the client just sees the close.
    if let Ok(mut raw) = stream.into_std() {
        let _ = raw.write(&response("503 Service Unavailable", "", body));
    }
    ctx.emit(ctx.event("deny", "", 0, peer).str("reason", "max_conns"));
}

fn response(status: &str, extra_headers: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         {extra_headers}\r\n\
         {body}",
        body.len()
    )
    .into_bytes()
}

/// Make a client-supplied host safe to echo in a plain-text response body.
fn printable(s: &str) -> String {
    s.chars()
        .take(255)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']' | '%') {
                c
            } else {
                '?'
            }
        })
        .collect()
}

/// Write an error response, half-close, and briefly drain so the peer sees
/// the response rather than a reset.
async fn respond_and_close(stream: &mut TcpStream, bytes: &[u8]) {
    let wrote = timeout(RESPONSE_WRITE_TIMEOUT, async {
        stream.write_all(bytes).await?;
        stream.shutdown().await
    })
    .await;
    if !matches!(wrote, Ok(Ok(()))) {
        return;
    }
    let _ = timeout(DRAIN_TIMEOUT, async {
        let mut sink = [0u8; 1024];
        let mut total = 0usize;
        while total < DRAIN_MAX_BYTES {
            match stream.read(&mut sink).await {
                Ok(0) | Err(_) => break,
                Ok(n) => total += n,
            }
        }
    })
    .await;
}

enum HeadRead {
    /// A full head is in the buffer; the value is its length (terminator
    /// included). Bytes after it, if any, arrived in the same read.
    Complete(usize),
    TooLarge,
    Closed,
}

/// Read until the first `CRLF CRLF`, never taking more than
/// [`MAX_HEAD_BYTES`] bytes off the socket.
async fn read_head(stream: &mut TcpStream, buf: &mut Vec<u8>) -> io::Result<HeadRead> {
    let mut chunk = [0u8; 1024];
    loop {
        let room = MAX_HEAD_BYTES - buf.len();
        if room == 0 {
            return Ok(HeadRead::TooLarge);
        }
        let want = room.min(chunk.len());
        let n = stream.read(&mut chunk[..want]).await?;
        if n == 0 {
            return Ok(HeadRead::Closed);
        }
        // The terminator may straddle two reads.
        let scan_from = buf.len().saturating_sub(3);
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = find_head_end(&buf[scan_from..]) {
            return Ok(HeadRead::Complete(scan_from + end));
        }
    }
}

async fn handle_connection(
    ctx: Arc<Ctx>,
    mut stream: TcpStream,
    peer: SocketAddr,
    force: watch::Receiver<bool>,
    _permit: OwnedSemaphorePermit,
) {
    let _ = stream.set_nodelay(true);

    let mut buf = Vec::with_capacity(1024);
    let head_len = match timeout(ctx.cfg.header_timeout, read_head(&mut stream, &mut buf)).await {
        Ok(Ok(HeadRead::Complete(n))) => n,
        Ok(Ok(HeadRead::TooLarge)) => {
            ctx.emit(
                ctx.event("deny", "", 0, peer)
                    .str("reason", "head_too_large"),
            );
            let body = "request head too large\n";
            respond_and_close(
                &mut stream,
                &response("431 Request Header Fields Too Large", "", body),
            )
            .await;
            return;
        }
        Ok(Ok(HeadRead::Closed)) | Ok(Err(_)) => {
            // Silent for bare connect-and-close probes; noted otherwise.
            if !buf.is_empty() {
                ctx.emit(
                    ctx.event("error", "", 0, peer)
                        .str("reason", "incomplete_head"),
                );
            }
            return;
        }
        Err(_) => {
            ctx.emit(
                ctx.event("deny", "", 0, peer)
                    .str("reason", "header_timeout"),
            );
            let body = "timed out waiting for request head\n";
            respond_and_close(&mut stream, &response("408 Request Timeout", "", body)).await;
            return;
        }
    };

    // Anything the client sent after the head is opaque tunnel payload (or
    // garbage, if the request is refused). It is never parsed.
    let early_data = buf.split_off(head_len);

    match parse_head(&buf) {
        Ok(Request::Health) => {
            respond_and_close(&mut stream, &response("200 OK", "", "ok\n")).await;
        }
        Ok(Request::Connect { host, port }) => {
            handle_connect(&ctx, stream, peer, &host, port, early_data, force).await;
        }
        Err(Rejection::BadRequest(why)) => {
            ctx.emit(
                ctx.event("deny", "", 0, peer)
                    .str("reason", "bad_request")
                    .str("detail", why),
            );
            let body = format!("bad request: {why}\n");
            respond_and_close(&mut stream, &response("400 Bad Request", "", &body)).await;
        }
        Err(Rejection::MethodNotAllowed { method, target }) => {
            ctx.emit(
                ctx.event("deny", "", 0, peer)
                    .str("reason", "method_not_allowed")
                    .str("method", &method)
                    .str("target", &target),
            );
            let body = "egress denied: this proxy only supports CONNECT host:port\n";
            respond_and_close(
                &mut stream,
                &response("405 Method Not Allowed", "Allow: CONNECT\r\n", body),
            )
            .await;
        }
        Err(Rejection::IpLiteral { host, port }) => {
            ctx.emit(
                ctx.event("deny", &host, port, peer)
                    .str("reason", "ip_literal"),
            );
            let body = format!(
                "egress denied: {}:{port} is an IP literal; only allowlisted hostnames are permitted\n",
                printable(&host)
            );
            respond_and_close(&mut stream, &response("403 Forbidden", "", &body)).await;
        }
    }
}

async fn handle_connect(
    ctx: &Ctx,
    mut client: TcpStream,
    peer: SocketAddr,
    host: &str,
    port: u16,
    early_data: Vec<u8>,
    force: watch::Receiver<bool>,
) {
    let started = Instant::now();

    // 1. Allowlist. Checked before any DNS query is made for the name.
    if !ctx.cfg.allowlist.allows(host, port) {
        ctx.emit(
            ctx.event("deny", host, port, peer)
                .str("reason", "not_allowlisted"),
        );
        let body = format!(
            "egress denied: {}:{port} is not on the allowlist\n",
            printable(host)
        );
        respond_and_close(&mut client, &response("403 Forbidden", "", &body)).await;
        return;
    }

    // 2. Resolve once. DNS and TCP connect share one deadline.
    let deadline = started + ctx.cfg.connect_timeout;
    let resolved = match timeout_at(deadline, ctx.resolver.resolve(host, port)).await {
        Ok(Ok(addrs)) => addrs,
        Ok(Err(e)) => {
            ctx.emit(
                ctx.event("error", host, port, peer)
                    .str("reason", "dns_failure")
                    .str("detail", &e.to_string()),
            );
            let body = format!("egress error: could not resolve {}\n", printable(host));
            respond_and_close(&mut client, &response("502 Bad Gateway", "", &body)).await;
            return;
        }
        Err(_) => {
            ctx.emit(
                ctx.event("error", host, port, peer)
                    .str("reason", "dns_timeout"),
            );
            let body = format!("egress error: timed out resolving {}\n", printable(host));
            respond_and_close(&mut client, &response("504 Gateway Timeout", "", &body)).await;
            return;
        }
    };
    if resolved.is_empty() {
        ctx.emit(
            ctx.event("error", host, port, peer)
                .str("reason", "dns_no_addresses"),
        );
        let body = format!("egress error: could not resolve {}\n", printable(host));
        respond_and_close(&mut client, &response("502 Bad Gateway", "", &body)).await;
        return;
    }

    // 3. Rebinding / SSRF guard: keep only addresses we are willing to dial.
    let mut candidates: Vec<IpAddr> = Vec::with_capacity(resolved.len());
    let mut first_blocked: Option<(IpAddr, &'static str)> = None;
    for ip in resolved {
        match blocked_reason(ip) {
            Some(why) if !ctx.cfg.allow_private_upstreams => {
                first_blocked.get_or_insert((ip, why));
            }
            _ => {
                if !candidates.contains(&ip) {
                    candidates.push(ip);
                }
            }
        }
    }
    if candidates.is_empty() {
        let mut rec = ctx
            .event("deny", host, port, peer)
            .str("reason", "blocked_address");
        if let Some((ip, why)) = first_blocked {
            rec = rec.str("resolved", &ip.to_string()).str("range", why);
        }
        ctx.emit(rec);
        let body = format!(
            "egress denied: {}:{port} resolves to a non-public address\n",
            printable(host)
        );
        respond_and_close(&mut client, &response("403 Forbidden", "", &body)).await;
        return;
    }

    // 4. Connect to an address we validated — by IP, never by name again.
    let mut upstream: Option<(TcpStream, SocketAddr)> = None;
    let mut failure = "connect_failed";
    let mut detail = String::new();
    for ip in candidates.into_iter().take(MAX_CONNECT_ATTEMPTS) {
        let addr = SocketAddr::new(ip, port);
        match timeout_at(deadline, TcpStream::connect(addr)).await {
            Ok(Ok(s)) => {
                upstream = Some((s, addr));
                break;
            }
            Ok(Err(e)) => {
                failure = "connect_failed";
                detail = e.to_string();
            }
            Err(_) => {
                failure = "connect_timeout";
                detail.clear();
                break;
            }
        }
    }
    let Some((mut upstream, upstream_addr)) = upstream else {
        let mut rec = ctx.event("error", host, port, peer).str("reason", failure);
        if !detail.is_empty() {
            rec = rec.str("detail", &detail);
        }
        ctx.emit(rec);
        let (status, what) = if failure == "connect_timeout" {
            ("504 Gateway Timeout", "timed out connecting to")
        } else {
            ("502 Bad Gateway", "could not connect to")
        };
        let body = format!("egress error: {what} {}:{port}\n", printable(host));
        respond_and_close(&mut client, &response(status, "", &body)).await;
        return;
    };
    let _ = upstream.set_nodelay(true);

    // 5. Tell the client the tunnel is up.
    let established = timeout(RESPONSE_WRITE_TIMEOUT, client.write_all(RESP_ESTABLISHED)).await;
    if !matches!(established, Ok(Ok(()))) {
        ctx.emit(
            ctx.event("error", host, port, peer)
                .str("reason", "client_gone"),
        );
        return;
    }
    ctx.emit(
        ctx.event("allow", host, port, peer)
            .str("upstream", &upstream_addr.to_string()),
    );

    // 6. Raw copy until done.
    let outcome = tunnel(
        &mut client,
        &mut upstream,
        &early_data,
        ctx.cfg.idle_timeout,
        force,
    )
    .await;
    ctx.emit(
        ctx.event("close", host, port, peer)
            .str("reason", outcome.reason)
            .num("bytes_up", outcome.bytes_up)
            .num("bytes_down", outcome.bytes_down)
            .num("duration_ms", millis(started.elapsed())),
    );
}

struct TunnelOutcome {
    reason: &'static str,
    bytes_up: u64,
    bytes_down: u64,
}

/// Shared "last byte moved" clock for the idle watchdog.
struct Activity {
    origin: Instant,
    last_ms: AtomicU64,
}

impl Activity {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
            last_ms: AtomicU64::new(0),
        }
    }

    fn touch(&self) {
        self.last_ms
            .store(millis(self.origin.elapsed()), Ordering::Relaxed);
    }

    fn last(&self) -> Instant {
        self.origin + Duration::from_millis(self.last_ms.load(Ordering::Relaxed))
    }
}

async fn tunnel(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    early_data: &[u8],
    idle: Duration,
    mut force: watch::Receiver<bool>,
) -> TunnelOutcome {
    let bytes_up = AtomicU64::new(0);
    let bytes_down = AtomicU64::new(0);
    let activity = Activity::new();

    let (mut client_r, mut client_w) = client.split();
    let (mut upstream_r, mut upstream_w) = upstream.split();

    let up = async {
        if !early_data.is_empty() {
            upstream_w.write_all(early_data).await?;
            bytes_up.fetch_add(early_data.len() as u64, Ordering::Relaxed);
            activity.touch();
        }
        pump(&mut client_r, &mut upstream_w, &bytes_up, &activity).await
    };
    let down = pump(&mut upstream_r, &mut client_w, &bytes_down, &activity);

    let watchdog = async {
        loop {
            let deadline = activity.last() + idle;
            if Instant::now() >= deadline {
                return;
            }
            sleep_until(deadline).await;
        }
    };
    let forced = async {
        // Resolves on a `true` value, or if the server has gone away.
        loop {
            if *force.borrow() {
                return;
            }
            if force.changed().await.is_err() {
                return;
            }
        }
    };

    let reason = tokio::select! {
        r = async { tokio::try_join!(up, down) } => match r {
            Ok(_) => "eof",
            Err(_) => "io_error",
        },
        () = watchdog => "idle_timeout",
        () = forced => "shutdown",
    };

    TunnelOutcome {
        reason,
        bytes_up: bytes_up.load(Ordering::Relaxed),
        bytes_down: bytes_down.load(Ordering::Relaxed),
    }
}

/// Copy `from` → `to` until EOF, then propagate the half-close.
async fn pump<R, W>(
    from: &mut R,
    to: &mut W,
    counter: &AtomicU64,
    activity: &Activity,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; COPY_BUF_BYTES];
    loop {
        let n = from.read(&mut buf).await?;
        if n == 0 {
            let _ = to.shutdown().await;
            return Ok(());
        }
        activity.touch();
        to.write_all(&buf[..n]).await?;
        counter.fetch_add(n as u64, Ordering::Relaxed);
        activity.touch();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printable_neutralises_hostile_input() {
        assert_eq!(printable("github.com"), "github.com");
        assert_eq!(printable("[::1]"), "[::1]");
        assert_eq!(printable("a\r\nb<script>"), "a??b?script?");
        assert_eq!(printable("é☃"), "??");
        assert_eq!(printable(&"a".repeat(1000)).len(), 255);
    }

    #[test]
    fn response_framing() {
        let r = String::from_utf8(response("403 Forbidden", "", "nope\n")).unwrap();
        assert!(r.starts_with("HTTP/1.1 403 Forbidden\r\n"));
        assert!(r.contains("\r\nContent-Length: 5\r\n"));
        assert!(r.contains("\r\nConnection: close\r\n"));
        assert!(r.ends_with("\r\n\r\nnope\n"));
        let r = String::from_utf8(response(
            "405 Method Not Allowed",
            "Allow: CONNECT\r\n",
            "x",
        ))
        .unwrap();
        assert!(r.contains("\r\nAllow: CONNECT\r\n\r\nx"));
        assert_eq!(r.matches("\r\n\r\n").count(), 1);
    }
}
