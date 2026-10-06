//! `egress-proxy` binary: environment → [`Config`] → [`Server`].
//!
//! Usage:
//!   egress-proxy                serve (configured by environment variables)
//!   egress-proxy --healthcheck  GET /healthz on the local listener; exit 0/1
//!   egress-proxy --version

#![forbid(unsafe_code)]

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream as StdTcpStream};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use egress_proxy::config::{parse_listen_addr, Config, DEFAULT_LISTEN_ADDR};
use egress_proxy::log::{LogSink, Record, StdoutSink};
use egress_proxy::proxy::{Server, SystemResolver};

const HEALTHCHECK_TIMEOUT: Duration = Duration::from_secs(3);

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => serve(),
        ["--healthcheck"] => healthcheck(),
        ["--version"] => {
            println!("egress-proxy {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: egress-proxy [--healthcheck | --version]");
            ExitCode::from(2)
        }
    }
}

fn fatal(log: &dyn LogSink, reason: &str, detail: &str) -> ExitCode {
    log.emit(
        Record::new("error")
            .str("reason", reason)
            .str("detail", detail)
            .finish(),
    );
    eprintln!("egress-proxy: {reason}: {detail}");
    ExitCode::from(2)
}

fn serve() -> ExitCode {
    let log: Arc<dyn LogSink> = Arc::new(StdoutSink);

    let cfg = match Config::from_lookup(|name| std::env::var(name).ok()) {
        Ok(cfg) => cfg,
        Err(e) => return fatal(log.as_ref(), "invalid_config", &e.to_string()),
    };

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_io()
        .enable_time()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => return fatal(log.as_ref(), "runtime_init_failed", &e.to_string()),
    };

    let code = runtime.block_on(async move {
        let listener = match tokio::net::TcpListener::bind(cfg.listen_addr).await {
            Ok(l) => l,
            Err(e) => {
                return fatal(
                    log.as_ref(),
                    "bind_failed",
                    &format!("{}: {e}", cfg.listen_addr),
                )
            }
        };
        let local = listener.local_addr().unwrap_or(cfg.listen_addr);
        let server = Server::new(cfg, Arc::new(SystemResolver), Arc::clone(&log));
        log.emit(server.startup_record(local));
        server.run(listener, shutdown_signal()).await;
        ExitCode::SUCCESS
    });
    // Do not let a stuck getaddrinfo() on the blocking pool delay exit.
    runtime.shutdown_timeout(Duration::from_secs(1));
    code
}

/// Resolves on SIGTERM or SIGINT. Handlers are installed explicitly, so this
/// also works when the proxy is PID 1 in its container.
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    match (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) {
        (Ok(mut term), Ok(mut int)) => {
            tokio::select! {
                _ = term.recv() => {}
                _ = int.recv() => {}
            }
        }
        _ => {
            eprintln!("egress-proxy: could not install signal handlers");
            std::future::pending::<()>().await;
        }
    }
}

/// `--healthcheck`: blocking `GET /healthz` against the local listener. Used
/// by the image's `HEALTHCHECK`, which has no shell or curl to lean on.
fn healthcheck() -> ExitCode {
    let listen = std::env::var("LISTEN_ADDR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_LISTEN_ADDR.to_string());
    let target = match parse_listen_addr(&listen) {
        Ok(addr) => loopback_for(addr),
        Err(e) => {
            eprintln!("healthcheck: {e}");
            return ExitCode::FAILURE;
        }
    };
    match probe(target) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("healthcheck: {target}: {e}");
            ExitCode::FAILURE
        }
    }
}

/// A wildcard listen address is probed via loopback of the same family.
fn loopback_for(addr: SocketAddr) -> SocketAddr {
    let ip = match addr.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    SocketAddr::new(ip, addr.port())
}

fn probe(target: SocketAddr) -> std::io::Result<()> {
    let mut stream = StdTcpStream::connect_timeout(&target, HEALTHCHECK_TIMEOUT)?;
    stream.set_read_timeout(Some(HEALTHCHECK_TIMEOUT))?;
    stream.set_write_timeout(Some(HEALTHCHECK_TIMEOUT))?;
    stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut response = Vec::with_capacity(256);
    stream.take(1024).read_to_end(&mut response)?;
    if response.starts_with(b"HTTP/1.1 200 ") {
        Ok(())
    } else {
        let first_line = response.split(|&b| b == b'\r').next().unwrap_or(&[]);
        Err(std::io::Error::other(format!(
            "unexpected response: {:?}",
            String::from_utf8_lossy(first_line)
        )))
    }
}
