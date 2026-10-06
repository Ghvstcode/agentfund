//! End-to-end tests of the server over real loopback sockets.
//!
//! The upstream is an in-process TCP echo server. Because it lives on
//! 127.0.0.1, tests that want a working tunnel set
//! `Config::allow_private_upstreams` directly (no environment mutation), and
//! the rebinding tests leave the guard on and inject a resolver that points an
//! allowlisted name at loopback.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

use egress_proxy::allowlist::Allowlist;
use egress_proxy::config::Config;
use egress_proxy::log::MemorySink;
use egress_proxy::proxy::{ResolveFuture, Resolver, Server};
use egress_proxy::request::MAX_HEAD_BYTES;

const IO_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------- fixtures

/// Resolver backed by a fixed table; records every query.
#[derive(Default)]
struct StaticResolver {
    table: HashMap<String, Vec<IpAddr>>,
    queries: Mutex<Vec<String>>,
}

impl StaticResolver {
    fn new(entries: &[(&str, &[&str])]) -> Arc<Self> {
        let table = entries
            .iter()
            .map(|(name, ips)| {
                (
                    name.to_string(),
                    ips.iter().map(|ip| ip.parse().unwrap()).collect(),
                )
            })
            .collect();
        Arc::new(Self {
            table,
            queries: Mutex::new(Vec::new()),
        })
    }

    fn queries(&self) -> Vec<String> {
        self.queries.lock().unwrap().clone()
    }
}

impl Resolver for StaticResolver {
    fn resolve<'a>(&'a self, host: &'a str, _port: u16) -> ResolveFuture<'a> {
        Box::pin(async move {
            self.queries.lock().unwrap().push(host.to_string());
            self.table
                .get(host)
                .cloned()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "NXDOMAIN"))
        })
    }
}

/// Resolver that never answers.
struct HangingResolver;

impl Resolver for HangingResolver {
    fn resolve<'a>(&'a self, _host: &'a str, _port: u16) -> ResolveFuture<'a> {
        Box::pin(std::future::pending())
    }
}

/// TCP echo server that records what it saw.
struct Echo {
    addr: SocketAddr,
    accepted: Arc<AtomicUsize>,
    received: Arc<Mutex<Vec<u8>>>,
}

impl Echo {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let received = Arc::new(Mutex::new(Vec::new()));
        let (acc, rec) = (Arc::clone(&accepted), Arc::clone(&received));
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else {
                    return;
                };
                acc.fetch_add(1, Ordering::SeqCst);
                let rec = Arc::clone(&rec);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        match s.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => {
                                rec.lock().unwrap().extend_from_slice(&buf[..n]);
                                if s.write_all(&buf[..n]).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                });
            }
        });
        Self {
            addr,
            accepted,
            received,
        }
    }

    fn port(&self) -> u16 {
        self.addr.port()
    }

    fn accepted(&self) -> usize {
        self.accepted.load(Ordering::SeqCst)
    }

    fn received(&self) -> Vec<u8> {
        self.received.lock().unwrap().clone()
    }
}

struct Proxy {
    addr: SocketAddr,
    log: Arc<MemorySink>,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl Proxy {
    async fn start(cfg: Config, resolver: Arc<dyn Resolver>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let log = Arc::new(MemorySink::new());
        let (tx, rx) = oneshot::channel::<()>();
        let server = Server::new(cfg, resolver, log.clone());
        log_line(&log, server.startup_record(addr));
        let task = tokio::spawn(async move {
            server
                .run(listener, async {
                    let _ = rx.await;
                })
                .await;
        });
        Self {
            addr,
            log,
            shutdown: Some(tx),
            task,
        }
    }

    async fn connect(&self) -> TcpStream {
        TcpStream::connect(self.addr).await.unwrap()
    }

    /// Send `request`, then read until the proxy closes the connection.
    async fn exchange(&self, request: &[u8]) -> String {
        let mut s = self.connect().await;
        s.write_all(request).await.unwrap();
        read_to_close(&mut s).await
    }

    /// Parsed log lines (every line must be valid JSON).
    fn events(&self) -> Vec<serde_json::Value> {
        self.log
            .lines()
            .iter()
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("bad log line {l}: {e}")))
            .collect()
    }

    fn events_with(&self, action: &str) -> Vec<serde_json::Value> {
        self.events()
            .into_iter()
            .filter(|e| e["action"] == action)
            .collect()
    }

    /// Wait until a log line with `action` exists.
    async fn wait_for(&self, action: &str) -> serde_json::Value {
        let start = Instant::now();
        loop {
            if let Some(e) = self.events_with(action).into_iter().next() {
                return e;
            }
            assert!(
                start.elapsed() < IO_TIMEOUT,
                "no {action:?} log line; got {:?}",
                self.log.lines()
            );
            sleep(Duration::from_millis(10)).await;
        }
    }
}

fn log_line(log: &Arc<MemorySink>, line: String) {
    use egress_proxy::log::LogSink;
    log.emit(line);
}

fn config(allow: &str) -> Config {
    let mut cfg = Config::new(Allowlist::parse(allow).unwrap());
    cfg.header_timeout = Duration::from_secs(5);
    cfg.connect_timeout = Duration::from_secs(5);
    cfg.idle_timeout = Duration::from_secs(30);
    cfg.shutdown_grace = Duration::from_millis(200);
    cfg
}

/// Config + resolver for a working tunnel to the echo server under the
/// allowlisted name `echo.test`.
fn echo_setup(echo: &Echo) -> (Config, Arc<StaticResolver>) {
    let mut cfg = config(&format!("echo.test:{}", echo.port()));
    cfg.allow_private_upstreams = true;
    (cfg, StaticResolver::new(&[("echo.test", &["127.0.0.1"])]))
}

async fn read_to_close(s: &mut TcpStream) -> String {
    let mut out = Vec::new();
    timeout(IO_TIMEOUT, s.read_to_end(&mut out))
        .await
        .expect("proxy did not close the connection")
        .ok();
    String::from_utf8_lossy(&out).into_owned()
}

/// Read exactly one response head, byte by byte, so no tunnel bytes are
/// consumed.
async fn read_head(s: &mut TcpStream) -> String {
    let mut out = Vec::new();
    let mut b = [0u8; 1];
    while !out.ends_with(b"\r\n\r\n") {
        let n = timeout(IO_TIMEOUT, s.read(&mut b))
            .await
            .expect("timed out reading response head")
            .unwrap();
        assert!(
            n == 1,
            "EOF in response head: {:?}",
            String::from_utf8_lossy(&out)
        );
        out.push(b[0]);
    }
    String::from_utf8(out).unwrap()
}

async fn read_exact(s: &mut TcpStream, n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    timeout(IO_TIMEOUT, s.read_exact(&mut buf))
        .await
        .expect("timed out reading tunnel data")
        .unwrap();
    buf
}

fn status(response: &str) -> &str {
    response.lines().next().unwrap_or("")
}

async fn open_tunnel(proxy: &Proxy, target: &str) -> TcpStream {
    let mut s = proxy.connect().await;
    s.write_all(format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let head = read_head(&mut s).await;
    assert_eq!(head, "HTTP/1.1 200 Connection Established\r\n\r\n");
    s
}

// ------------------------------------------------------------------- tests

#[tokio::test]
async fn allowed_tunnel_passes_bytes_both_ways() {
    let echo = Echo::start().await;
    let (cfg, resolver) = echo_setup(&echo);
    let proxy = Proxy::start(cfg, resolver.clone()).await;
    let target = format!("echo.test:{}", echo.port());

    let mut s = open_tunnel(&proxy, &target).await;
    s.write_all(b"hello upstream").await.unwrap();
    assert_eq!(read_exact(&mut s, 14).await, b"hello upstream");

    // Binary payload, larger than the copy buffer, in both directions.
    let blob: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let (mut r, mut w) = s.into_split();
    let to_send = blob.clone();
    let writer = tokio::spawn(async move {
        w.write_all(&to_send).await.unwrap();
        w.shutdown().await.unwrap();
    });
    let mut echoed = Vec::new();
    timeout(IO_TIMEOUT, r.read_to_end(&mut echoed))
        .await
        .unwrap()
        .unwrap();
    writer.await.unwrap();
    assert_eq!(echoed, blob);

    let allow = proxy.wait_for("allow").await;
    assert_eq!(allow["host"], "echo.test");
    assert_eq!(allow["port"], echo.port());
    assert_eq!(allow["upstream"], format!("127.0.0.1:{}", echo.port()));
    assert!(allow["client"].as_str().unwrap().starts_with("127.0.0.1:"));
    assert!(allow["ts"].as_str().unwrap().ends_with('Z'));

    let close = proxy.wait_for("close").await;
    assert_eq!(close["host"], "echo.test");
    assert_eq!(close["port"], echo.port());
    assert_eq!(close["bytes_up"], 200_014);
    assert_eq!(close["bytes_down"], 200_014);
    assert_eq!(close["reason"], "eof");
    assert!(close["duration_ms"].is_u64());

    assert_eq!(
        resolver.queries(),
        vec!["echo.test"],
        "resolved exactly once"
    );
    assert_eq!(echo.accepted(), 1);
}

#[tokio::test]
async fn nothing_from_the_request_head_reaches_upstream() {
    let echo = Echo::start().await;
    let (cfg, resolver) = echo_setup(&echo);
    let proxy = Proxy::start(cfg, resolver).await;
    let target = format!("echo.test:{}", echo.port());

    let mut s = proxy.connect().await;
    let head = format!(
        "CONNECT {target} HTTP/1.1\r\n\
         Host: {target}\r\n\
         Proxy-Authorization: Basic c2VjcmV0OnNlY3JldA==\r\n\
         User-Agent: sandbox\r\n\
         X-Secret: do-not-forward\r\n\r\n"
    );
    s.write_all(head.as_bytes()).await.unwrap();
    assert_eq!(
        read_head(&mut s).await,
        "HTTP/1.1 200 Connection Established\r\n\r\n"
    );
    s.write_all(b"PAYLOAD").await.unwrap();
    assert_eq!(read_exact(&mut s, 7).await, b"PAYLOAD");
    assert_eq!(
        echo.received(),
        b"PAYLOAD",
        "upstream saw only tunnel bytes"
    );
}

#[tokio::test]
async fn bytes_pipelined_after_the_head_are_tunnelled_not_parsed() {
    let echo = Echo::start().await;
    let (cfg, resolver) = echo_setup(&echo);
    let proxy = Proxy::start(cfg, resolver.clone()).await;
    let target = format!("echo.test:{}", echo.port());

    // A second "request" glued onto the first must be treated as opaque
    // payload for the allowlisted upstream, never as a new proxy request.
    let smuggled = "CONNECT evil.example:443 HTTP/1.1\r\n\r\n";
    let mut s = proxy.connect().await;
    s.write_all(format!("CONNECT {target} HTTP/1.1\r\n\r\n{smuggled}").as_bytes())
        .await
        .unwrap();
    assert_eq!(
        read_head(&mut s).await,
        "HTTP/1.1 200 Connection Established\r\n\r\n"
    );
    assert_eq!(
        read_exact(&mut s, smuggled.len()).await,
        smuggled.as_bytes()
    );
    assert_eq!(echo.received(), smuggled.as_bytes());
    assert_eq!(resolver.queries(), vec!["echo.test"]);
    drop(s);
    let close = proxy.wait_for("close").await;
    assert_eq!(close["bytes_up"], smuggled.len());
    assert!(proxy.events_with("deny").is_empty());
}

#[tokio::test]
async fn denied_host_gets_403_and_is_never_resolved() {
    let echo = Echo::start().await;
    let (cfg, _) = echo_setup(&echo);
    // Resolver knows the denied name: proves the allowlist, not DNS, said no.
    let resolver = StaticResolver::new(&[
        ("echo.test", &["127.0.0.1"]),
        ("example.com", &["127.0.0.1"]),
    ]);
    let proxy = Proxy::start(cfg, resolver.clone()).await;

    let resp = proxy
        .exchange(format!("CONNECT example.com:{} HTTP/1.1\r\n\r\n", echo.port()).as_bytes())
        .await;
    assert_eq!(status(&resp), "HTTP/1.1 403 Forbidden");
    assert!(resp.contains("example.com"), "body names the host: {resp}");
    assert!(resp.contains("not on the allowlist"));
    assert!(resp.contains("Connection: close"));

    assert!(
        resolver.queries().is_empty(),
        "denied host must not be resolved"
    );
    assert_eq!(echo.accepted(), 0);
    let deny = proxy.wait_for("deny").await;
    assert_eq!(deny["host"], "example.com");
    assert_eq!(deny["port"], echo.port());
    assert_eq!(deny["reason"], "not_allowlisted");
    assert!(proxy.events_with("allow").is_empty());
}

#[tokio::test]
async fn allowlist_port_and_subdomain_are_enforced_over_the_wire() {
    let echo = Echo::start().await;
    let (cfg, _) = echo_setup(&echo);
    let resolver = StaticResolver::new(&[
        ("echo.test", &["127.0.0.1"]),
        ("sub.echo.test", &["127.0.0.1"]),
    ]);
    let proxy = Proxy::start(cfg, resolver.clone()).await;
    let other_port = if echo.port() == 443 { 444 } else { 443 };

    for target in [
        format!("echo.test:{other_port}"),
        format!("sub.echo.test:{}", echo.port()),
        format!("xecho.test:{}", echo.port()),
        format!("echo.test.evil.example:{}", echo.port()),
    ] {
        let resp = proxy
            .exchange(format!("CONNECT {target} HTTP/1.1\r\n\r\n").as_bytes())
            .await;
        assert_eq!(status(&resp), "HTTP/1.1 403 Forbidden", "{target}");
    }
    assert!(resolver.queries().is_empty());
    assert_eq!(echo.accepted(), 0);

    // Case and trailing dot are normalised.
    let mut s = open_tunnel(&proxy, &format!("ECHO.Test.:{}", echo.port())).await;
    s.write_all(b"x").await.unwrap();
    assert_eq!(read_exact(&mut s, 1).await, b"x");
}

#[tokio::test]
async fn empty_allowlist_denies_everything() {
    let proxy = Proxy::start(
        config(""),
        StaticResolver::new(&[("github.com", &["140.82.112.3"])]),
    )
    .await;
    let resp = proxy
        .exchange(b"CONNECT github.com:443 HTTP/1.1\r\n\r\n")
        .await;
    assert_eq!(status(&resp), "HTTP/1.1 403 Forbidden");
    let start = proxy.wait_for("start").await;
    assert_eq!(start["allow"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn non_connect_gets_405() {
    let echo = Echo::start().await;
    let (cfg, resolver) = echo_setup(&echo);
    let proxy = Proxy::start(cfg, resolver.clone()).await;

    for req in [
        "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n".to_string(),
        format!(
            "GET http://echo.test:{0}/ HTTP/1.1\r\nHost: echo.test:{0}\r\n\r\n",
            echo.port()
        ),
        "POST http://example.com/upload HTTP/1.1\r\nHost: example.com\r\nContent-Length: 4\r\n\r\ndata".to_string(),
        "GET / HTTP/1.1\r\nHost: proxy\r\n\r\n".to_string(),
        "HEAD /healthz HTTP/1.1\r\n\r\n".to_string(),
        "OPTIONS * HTTP/1.1\r\n\r\n".to_string(),
        "connect echo.test:443 HTTP/1.1\r\n\r\n".to_string(),
    ] {
        let resp = proxy.exchange(req.as_bytes()).await;
        assert_eq!(status(&resp), "HTTP/1.1 405 Method Not Allowed", "{req:?}");
        assert!(resp.contains("Allow: CONNECT"), "{resp}");
    }
    assert!(resolver.queries().is_empty());
    assert_eq!(
        echo.accepted(),
        0,
        "plain HTTP must never reach an upstream"
    );
    let deny = proxy.wait_for("deny").await;
    assert_eq!(deny["reason"], "method_not_allowed");
    assert_eq!(deny["method"], "GET");
    assert_eq!(deny["target"], "http://example.com/");
}

#[tokio::test]
async fn ip_literal_targets_are_denied_even_when_private_upstreams_are_allowed() {
    let echo = Echo::start().await;
    let (cfg, resolver) = echo_setup(&echo);
    assert!(cfg.allow_private_upstreams);
    let proxy = Proxy::start(cfg, resolver.clone()).await;
    let p = echo.port();

    for host in [
        "127.0.0.1",
        "127.1",
        "0x7f.1",
        "0x7f000001",
        "0177.0.0.1",
        "2130706433",
        "[::1]",
        "[::ffff:127.0.0.1]",
        "::1",
        "1.1.1.1",
        "169.254.169.254",
    ] {
        let resp = proxy
            .exchange(format!("CONNECT {host}:{p} HTTP/1.1\r\n\r\n").as_bytes())
            .await;
        assert_eq!(status(&resp), "HTTP/1.1 403 Forbidden", "{host}");
        assert!(resp.contains("IP literal"), "{host}: {resp}");
    }
    assert!(resolver.queries().is_empty());
    assert_eq!(echo.accepted(), 0);
    let denies = proxy.events_with("deny");
    assert_eq!(denies.len(), 11);
    assert!(denies.iter().all(|d| d["reason"] == "ip_literal"));
    assert_eq!(denies[0]["host"], "127.0.0.1");
    assert_eq!(denies[0]["port"], p);
}

#[tokio::test]
async fn rebinding_guard_blocks_allowlisted_name_resolving_to_loopback() {
    let echo = Echo::start().await;
    // Allowlisted, and the guard is ON (the default).
    let cfg = config(&format!("echo.test:{}", echo.port()));
    assert!(!cfg.allow_private_upstreams);
    let resolver = StaticResolver::new(&[("echo.test", &["127.0.0.1"])]);
    let proxy = Proxy::start(cfg, resolver.clone()).await;

    let resp = proxy
        .exchange(format!("CONNECT echo.test:{} HTTP/1.1\r\n\r\n", echo.port()).as_bytes())
        .await;
    assert_eq!(status(&resp), "HTTP/1.1 403 Forbidden");
    assert!(resp.contains("echo.test"));
    assert!(resp.contains("non-public"));

    assert_eq!(resolver.queries(), vec!["echo.test"]);
    assert_eq!(
        echo.accepted(),
        0,
        "no connection may reach the loopback service"
    );
    let deny = proxy.wait_for("deny").await;
    assert_eq!(deny["reason"], "blocked_address");
    assert_eq!(deny["resolved"], "127.0.0.1");
    assert_eq!(deny["range"], "loopback");
    assert!(proxy.events_with("allow").is_empty());
}

#[tokio::test]
async fn rebinding_guard_covers_every_internal_range() {
    let echo = Echo::start().await;
    let names: Vec<(&str, &[&str])> = vec![
        ("loop6.test", &["::1"]),
        ("mapped.test", &["::ffff:127.0.0.1"]),
        ("rfc1918a.test", &["10.0.0.5"]),
        ("rfc1918b.test", &["172.17.0.1"]),
        ("rfc1918c.test", &["192.168.1.1"]),
        ("metadata.test", &["169.254.169.254"]),
        ("cgnat.test", &["100.64.0.1"]),
        ("ula.test", &["fd00::1"]),
        ("ll6.test", &["fe80::1"]),
        ("mcast.test", &["224.0.0.1"]),
        ("unspec.test", &["0.0.0.0"]),
        ("unspec6.test", &["::"]),
        ("nat64.test", &["64:ff9b::7f00:1"]),
        // Several answers, all internal.
        ("multi.test", &["10.0.0.1", "127.0.0.1", "::1"]),
    ];
    let allow = names
        .iter()
        .map(|(n, _)| format!("{n}:{}", echo.port()))
        .collect::<Vec<_>>()
        .join(",");
    let proxy = Proxy::start(config(&allow), StaticResolver::new(&names)).await;

    for (name, _) in &names {
        let resp = proxy
            .exchange(format!("CONNECT {name}:{} HTTP/1.1\r\n\r\n", echo.port()).as_bytes())
            .await;
        assert_eq!(status(&resp), "HTTP/1.1 403 Forbidden", "{name}");
    }
    assert_eq!(echo.accepted(), 0);
    let denies = proxy.events_with("deny");
    assert_eq!(denies.len(), names.len());
    assert!(denies.iter().all(|d| d["reason"] == "blocked_address"));
}

#[tokio::test]
async fn mixed_answers_never_dial_the_internal_address() {
    // Several answers from different blocked ranges, loopback (where the echo
    // server really listens) first: none may be dialled.
    let echo = Echo::start().await;
    let mut cfg = config(&format!("mixed.test:{}", echo.port()));
    cfg.connect_timeout = Duration::from_millis(300);
    let resolver = StaticResolver::new(&[("mixed.test", &["127.0.0.1", "192.0.2.1", "10.1.2.3"])]);
    let proxy = Proxy::start(cfg, resolver).await;

    let resp = proxy
        .exchange(format!("CONNECT mixed.test:{} HTTP/1.1\r\n\r\n", echo.port()).as_bytes())
        .await;
    assert_eq!(status(&resp), "HTTP/1.1 403 Forbidden");
    assert_eq!(echo.accepted(), 0);
}

#[tokio::test]
async fn max_conns_is_enforced() {
    let echo = Echo::start().await;
    let (mut cfg, resolver) = echo_setup(&echo);
    cfg.max_conns = 2;
    let proxy = Proxy::start(cfg, resolver).await;

    // Two connections occupy both slots: one open tunnel, one idle client.
    let target = format!("echo.test:{}", echo.port());
    let mut tunnel = open_tunnel(&proxy, &target).await;
    let idle = proxy.connect().await;
    // Make sure the proxy has accepted the idle one before the third arrives.
    sleep(Duration::from_millis(100)).await;

    for _ in 0..3 {
        let mut third = proxy.connect().await;
        let resp = read_to_close(&mut third).await;
        assert_eq!(status(&resp), "HTTP/1.1 503 Service Unavailable");
    }
    let deny = proxy.wait_for("deny").await;
    assert_eq!(deny["reason"], "max_conns");

    // The established tunnel is unaffected.
    tunnel.write_all(b"still here").await.unwrap();
    assert_eq!(read_exact(&mut tunnel, 10).await, b"still here");

    // Freeing a slot lets new clients in again.
    drop(idle);
    let start = Instant::now();
    loop {
        let resp = proxy.exchange(b"GET /healthz HTTP/1.1\r\n\r\n").await;
        if status(&resp) == "HTTP/1.1 200 OK" {
            break;
        }
        assert!(start.elapsed() < IO_TIMEOUT, "slot never freed: {resp}");
        sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn slow_header_times_out() {
    let echo = Echo::start().await;
    let (mut cfg, resolver) = echo_setup(&echo);
    cfg.header_timeout = Duration::from_millis(300);
    let proxy = Proxy::start(cfg, resolver.clone()).await;

    // Slowloris: trickle a head that never completes. The deadline is for
    // the whole head, so trickling does not extend it.
    let mut s = proxy.connect().await;
    let started = Instant::now();
    let (mut r, mut w) = s.split();
    let trickle = async {
        for chunk in "CONNECT echo.test:443 HTTP/1.1\r\nX-Slow: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .as_bytes()
            .chunks(2)
        {
            if w.write_all(chunk).await.is_err() {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
    };
    let read = async {
        let mut out = Vec::new();
        let _ = timeout(IO_TIMEOUT, r.read_to_end(&mut out)).await;
        String::from_utf8_lossy(&out).into_owned()
    };
    let (_, resp) = tokio::join!(trickle, read);
    let elapsed = started.elapsed();

    assert_eq!(status(&resp), "HTTP/1.1 408 Request Timeout");
    assert!(
        elapsed >= Duration::from_millis(250),
        "too early: {elapsed:?}"
    );
    assert!(elapsed < Duration::from_secs(3), "too late: {elapsed:?}");
    let deny = proxy.wait_for("deny").await;
    assert_eq!(deny["reason"], "header_timeout");
    assert!(resolver.queries().is_empty());

    // A completely silent client is dropped on the same schedule.
    let mut silent = proxy.connect().await;
    let started = Instant::now();
    let resp = read_to_close(&mut silent).await;
    assert_eq!(status(&resp), "HTTP/1.1 408 Request Timeout");
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn oversized_head_is_rejected() {
    let echo = Echo::start().await;
    let (cfg, resolver) = echo_setup(&echo);
    let proxy = Proxy::start(cfg, resolver.clone()).await;

    let mut req = format!("CONNECT echo.test:{} HTTP/1.1\r\nX-Pad: ", echo.port()).into_bytes();
    req.resize(MAX_HEAD_BYTES + 1, b'a');
    // No terminator within the limit; the proxy must answer without waiting
    // for more.
    let mut s = proxy.connect().await;
    s.write_all(&req).await.unwrap();
    let resp = read_to_close(&mut s).await;
    assert_eq!(
        status(&resp),
        "HTTP/1.1 431 Request Header Fields Too Large"
    );
    assert!(resolver.queries().is_empty());
    assert_eq!(echo.accepted(), 0);
    assert_eq!(proxy.wait_for("deny").await["reason"], "head_too_large");

    // A head of exactly the maximum size still works.
    let prefix = format!("CONNECT echo.test:{} HTTP/1.1\r\nX-Pad: ", echo.port());
    let pad = "a".repeat(MAX_HEAD_BYTES - prefix.len() - 4);
    let exact = format!("{prefix}{pad}\r\n\r\n");
    assert_eq!(exact.len(), MAX_HEAD_BYTES);
    let mut s = proxy.connect().await;
    s.write_all(exact.as_bytes()).await.unwrap();
    assert_eq!(
        read_head(&mut s).await,
        "HTTP/1.1 200 Connection Established\r\n\r\n"
    );
}

#[tokio::test]
async fn malformed_requests_get_400() {
    let echo = Echo::start().await;
    let (cfg, resolver) = echo_setup(&echo);
    let proxy = Proxy::start(cfg, resolver.clone()).await;

    for req in [
        &b"\r\n\r\n"[..],
        b"CONNECT\r\n\r\n",
        b"CONNECT echo.test HTTP/1.1\r\n\r\n",
        b"CONNECT echo.test:0 HTTP/1.1\r\n\r\n",
        b"CONNECT echo.test:99999 HTTP/1.1\r\n\r\n",
        b"CONNECT  echo.test:443 HTTP/1.1\r\n\r\n",
        b"CONNECT echo.test:443 HTTP/2.0\r\n\r\n",
        b"CONNECT user@echo.test:443 HTTP/1.1\r\n\r\n",
        b"CONNECT echo.test:443 HTTP/1.1\r\nBroken Header\r\n\r\n",
        b"CONNECT echo.test:443 HTTP/1.1\r\n folded: x\r\n\r\n",
        b"CONNECT echo\x00.test:443 HTTP/1.1\r\n\r\n",
        b"CONNECT \xc3\xa9cho.test:443 HTTP/1.1\r\n\r\n",
        b"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03\r\n\r\n",
    ] {
        let resp = proxy.exchange(req).await;
        assert_eq!(
            status(&resp),
            "HTTP/1.1 400 Bad Request",
            "{:?}",
            String::from_utf8_lossy(req)
        );
    }
    assert!(resolver.queries().is_empty());
    assert_eq!(echo.accepted(), 0);
}

#[tokio::test]
async fn healthz_returns_200_ok() {
    let proxy = Proxy::start(config(""), StaticResolver::new(&[])).await;
    let resp = proxy
        .exchange(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await;
    assert_eq!(status(&resp), "HTTP/1.1 200 OK");
    assert!(resp.ends_with("\r\n\r\nok\n"), "{resp}");
    // Health checks are not logged as policy events.
    assert!(proxy.events_with("deny").is_empty());
    assert!(proxy.events_with("allow").is_empty());
}

#[tokio::test]
async fn idle_tunnel_is_closed() {
    let echo = Echo::start().await;
    let (mut cfg, resolver) = echo_setup(&echo);
    cfg.idle_timeout = Duration::from_millis(300);
    let proxy = Proxy::start(cfg, resolver).await;

    let mut s = open_tunnel(&proxy, &format!("echo.test:{}", echo.port())).await;
    // Activity keeps it alive past one idle period...
    for _ in 0..4 {
        sleep(Duration::from_millis(150)).await;
        s.write_all(b"k").await.unwrap();
        assert_eq!(read_exact(&mut s, 1).await, b"k");
    }
    // ...then silence gets it closed.
    let started = Instant::now();
    let rest = read_to_close(&mut s).await;
    assert!(rest.is_empty());
    assert!(started.elapsed() < Duration::from_secs(3));
    let close = proxy.wait_for("close").await;
    assert_eq!(close["reason"], "idle_timeout");
    assert_eq!(close["bytes_up"], 4);
    assert_eq!(close["bytes_down"], 4);
}

#[tokio::test]
async fn upstream_failures_are_reported_as_gateway_errors() {
    // Allowlisted name → loopback port with nothing listening.
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_port = dead.local_addr().unwrap().port();
    drop(dead);
    let mut cfg = config(&format!("dead.test:{dead_port},nx.test,hang.test"));
    cfg.allow_private_upstreams = true;
    cfg.connect_timeout = Duration::from_millis(300);
    let resolver = StaticResolver::new(&[("dead.test", &["127.0.0.1"])]);
    let proxy = Proxy::start(cfg.clone(), resolver).await;

    let resp = proxy
        .exchange(format!("CONNECT dead.test:{dead_port} HTTP/1.1\r\n\r\n").as_bytes())
        .await;
    assert_eq!(status(&resp), "HTTP/1.1 502 Bad Gateway");
    let resp = proxy
        .exchange(b"CONNECT nx.test:443 HTTP/1.1\r\n\r\n")
        .await;
    assert_eq!(status(&resp), "HTTP/1.1 502 Bad Gateway");
    let reasons: Vec<String> = proxy
        .events_with("error")
        .iter()
        .map(|e| e["reason"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(reasons, vec!["connect_failed", "dns_failure"]);

    // A resolver that never answers is cut off by the connect timeout.
    let proxy = Proxy::start(cfg, Arc::new(HangingResolver)).await;
    let started = Instant::now();
    let resp = proxy
        .exchange(b"CONNECT hang.test:443 HTTP/1.1\r\n\r\n")
        .await;
    assert_eq!(status(&resp), "HTTP/1.1 504 Gateway Timeout");
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(proxy.wait_for("error").await["reason"], "dns_timeout");
}

#[tokio::test]
async fn graceful_shutdown_stops_accepting_and_closes_tunnels() {
    let echo = Echo::start().await;
    let (cfg, resolver) = echo_setup(&echo);
    let mut proxy = Proxy::start(cfg, resolver).await;

    let mut s = open_tunnel(&proxy, &format!("echo.test:{}", echo.port())).await;
    s.write_all(b"abc").await.unwrap();
    assert_eq!(read_exact(&mut s, 3).await, b"abc");

    proxy.shutdown.take().unwrap().send(()).unwrap();

    // The open tunnel is force-closed after the (200 ms) grace period and the
    // server task finishes.
    let rest = read_to_close(&mut s).await;
    assert!(rest.is_empty());
    timeout(IO_TIMEOUT, &mut proxy.task)
        .await
        .expect("server did not stop")
        .unwrap();

    assert!(
        TcpStream::connect(proxy.addr).await.is_err(),
        "listener must be closed after shutdown"
    );
    let close = proxy.wait_for("close").await;
    assert_eq!(close["reason"], "shutdown");
    assert_eq!(close["bytes_up"], 3);
    assert_eq!(close["bytes_down"], 3);
    let actions: Vec<String> = proxy
        .events()
        .iter()
        .map(|e| e["action"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        actions,
        vec!["start", "allow", "shutdown", "close", "stopped"]
    );
}

#[tokio::test]
async fn startup_line_lists_the_effective_allowlist() {
    let proxy = Proxy::start(
        config("API.Anthropic.com, github.com.,*.githubusercontent.com:443,github.com:22"),
        StaticResolver::new(&[]),
    )
    .await;
    let start = proxy.wait_for("start").await;
    assert_eq!(
        start["allow"],
        serde_json::json!([
            "api.anthropic.com:443",
            "github.com:443",
            "*.githubusercontent.com:443",
            "github.com:22"
        ])
    );
    assert_eq!(start["allow_private_upstreams"], false);
    assert_eq!(start["max_conns"], 256);
    assert_eq!(start["listen"], proxy.addr.to_string());
}

#[tokio::test]
async fn many_concurrent_tunnels() {
    let echo = Echo::start().await;
    let (cfg, resolver) = echo_setup(&echo);
    let proxy = Arc::new(Proxy::start(cfg, resolver).await);
    let target = format!("echo.test:{}", echo.port());

    let mut tasks = Vec::new();
    for i in 0..64u32 {
        let proxy = Arc::clone(&proxy);
        let target = target.clone();
        tasks.push(tokio::spawn(async move {
            let mut s = open_tunnel(&proxy, &target).await;
            let msg = format!("client-{i}-payload").into_bytes();
            s.write_all(&msg).await.unwrap();
            assert_eq!(read_exact(&mut s, msg.len()).await, msg);
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    assert_eq!(echo.accepted(), 64);
    assert_eq!(proxy.events_with("allow").len(), 64);
}
