//! Request-head parsing. Pure; no I/O.
//!
//! The proxy reads bytes up to and including the first `CRLF CRLF`, hands
//! exactly that slice to [`parse_head`], and never parses anything else from
//! the connection. Parsing is deliberately strict: anything unusual is a
//! `400`, not something to be "repaired".

use crate::allowlist::parse_port;
use crate::host::{normalize_hostname, HostError};

/// Hard cap on the size of the request head, terminator included.
pub const MAX_HEAD_BYTES: usize = 8192;

/// Path served by the built-in health endpoint.
pub const HEALTH_PATH: &str = "/healthz";

const TERMINATOR: &[u8] = b"\r\n\r\n";

/// A request the proxy is willing to act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// `CONNECT host:port` with a syntactically valid, normalised hostname
    /// that is not an IP literal. The allowlist has NOT been consulted yet.
    Connect { host: String, port: u16 },
    /// `GET /healthz` in origin-form.
    Health,
}

/// A request the proxy refuses on syntax alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// Malformed head → `400`.
    BadRequest(&'static str),
    /// Well-formed, but not CONNECT (and not the health check) → `405`.
    MethodNotAllowed { method: String, target: String },
    /// CONNECT to an IP literal in any spelling → `403`.
    IpLiteral { host: String, port: u16 },
}

/// Index one past the end of the first `CRLF CRLF` in `buf`, if present.
pub fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(TERMINATOR.len())
        .position(|w| w == TERMINATOR)
        .map(|i| i + TERMINATOR.len())
}

/// Parse a complete request head (request line + header lines + the empty
/// line). `head` must end with the first `CRLF CRLF` of the stream.
///
/// Header fields are validated for shape and then discarded: nothing in them
/// (`Host`, `Proxy-Authorization`, ...) influences the decision and nothing is
/// ever forwarded upstream.
pub fn parse_head(head: &[u8]) -> Result<Request, Rejection> {
    if head.len() > MAX_HEAD_BYTES {
        return Err(Rejection::BadRequest("request head too large"));
    }
    let Some(body) = head.strip_suffix(TERMINATOR) else {
        return Err(Rejection::BadRequest("request head not terminated"));
    };
    if !body
        .iter()
        .all(|&b| b == b'\r' || b == b'\n' || b == b'\t' || (0x20..0x7f).contains(&b))
    {
        return Err(Rejection::BadRequest("non-ASCII or control byte in head"));
    }
    let Ok(text) = std::str::from_utf8(body) else {
        return Err(Rejection::BadRequest("non-ASCII or control byte in head"));
    };

    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    if request_line.contains(['\r', '\n', '\t']) {
        return Err(Rejection::BadRequest("malformed request line"));
    }
    let parts: Vec<&str> = request_line.split(' ').collect();
    let [method, target, version] = parts.as_slice() else {
        return Err(Rejection::BadRequest("malformed request line"));
    };
    if method.is_empty() || !method.bytes().all(is_tchar) {
        return Err(Rejection::BadRequest("malformed method"));
    }
    if target.is_empty() {
        return Err(Rejection::BadRequest("empty request target"));
    }
    if *version != "HTTP/1.1" && *version != "HTTP/1.0" {
        return Err(Rejection::BadRequest("unsupported HTTP version"));
    }

    for line in lines {
        validate_header_line(line)?;
    }

    match *method {
        "CONNECT" => parse_connect_target(target),
        "GET" if *target == HEALTH_PATH => Ok(Request::Health),
        _ => Err(Rejection::MethodNotAllowed {
            method: (*method).to_string(),
            target: (*target).to_string(),
        }),
    }
}

fn validate_header_line(line: &str) -> Result<(), Rejection> {
    if line.contains(['\r', '\n']) {
        return Err(Rejection::BadRequest("bare CR or LF in header"));
    }
    // Rejects empty lines and obsolete line folding (leading SP / HTAB).
    let Some((name, _value)) = line.split_once(':') else {
        return Err(Rejection::BadRequest("malformed header line"));
    };
    if name.is_empty() || !name.bytes().all(is_tchar) {
        return Err(Rejection::BadRequest("malformed header name"));
    }
    Ok(())
}

/// Parse the authority-form target of a CONNECT request: `host:port`, port
/// mandatory.
fn parse_connect_target(target: &str) -> Result<Request, Rejection> {
    if let Some(rest) = target.strip_prefix('[') {
        // Bracketed IPv6 literal: well-formed enough to name → 403.
        let Some((inner, after)) = rest.split_once(']') else {
            return Err(Rejection::BadRequest("malformed CONNECT target"));
        };
        let Some(port) = after.strip_prefix(':') else {
            return Err(Rejection::BadRequest("CONNECT target must be host:port"));
        };
        let port = parse_port(port).map_err(|_| Rejection::BadRequest("invalid port"))?;
        return Err(Rejection::IpLiteral {
            host: format!("[{inner}]"),
            port,
        });
    }
    let Some((host, port)) = target.rsplit_once(':') else {
        return Err(Rejection::BadRequest("CONNECT target must be host:port"));
    };
    let port = parse_port(port).map_err(|_| Rejection::BadRequest("invalid port"))?;
    match normalize_hostname(host) {
        Ok(host) => Ok(Request::Connect { host, port }),
        Err(HostError::IpLiteral) => Err(Rejection::IpLiteral {
            host: host.to_string(),
            port,
        }),
        Err(_) => Err(Rejection::BadRequest("invalid hostname in CONNECT target")),
    }
}

/// RFC 9110 `tchar`.
fn is_tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Result<Request, Rejection> {
        parse_head(s.as_bytes())
    }

    fn connect(host: &str, port: u16) -> Result<Request, Rejection> {
        Ok(Request::Connect {
            host: host.to_string(),
            port,
        })
    }

    fn is_bad(r: &Result<Request, Rejection>) -> bool {
        matches!(r, Err(Rejection::BadRequest(_)))
    }

    #[test]
    fn find_head_end_basics() {
        assert_eq!(find_head_end(b""), None);
        assert_eq!(find_head_end(b"\r\n\r"), None);
        assert_eq!(find_head_end(b"\r\n\r\n"), Some(4));
        assert_eq!(find_head_end(b"A\r\n\r\nrest"), Some(5));
        assert_eq!(find_head_end(b"A\r\nB: c\r\n\r\n\r\n\r\n"), Some(11));
        assert_eq!(
            find_head_end(b"A\n\nB"),
            None,
            "bare LF is not a terminator"
        );
        assert_eq!(find_head_end(b"A\r\n\nB\n\r\n"), None);
    }

    #[test]
    fn minimal_connect() {
        assert_eq!(
            parse("CONNECT github.com:443 HTTP/1.1\r\n\r\n"),
            connect("github.com", 443)
        );
        assert_eq!(
            parse("CONNECT github.com:443 HTTP/1.0\r\n\r\n"),
            connect("github.com", 443)
        );
    }

    #[test]
    fn connect_as_sent_by_curl() {
        let head = "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\
                    Host: api.anthropic.com:443\r\n\
                    User-Agent: curl/8.5.0\r\n\
                    Proxy-Connection: Keep-Alive\r\n\r\n";
        assert_eq!(parse(head), connect("api.anthropic.com", 443));
    }

    #[test]
    fn host_is_normalised() {
        assert_eq!(
            parse("CONNECT GitHub.COM.:443 HTTP/1.1\r\n\r\n"),
            connect("github.com", 443)
        );
    }

    #[test]
    fn headers_never_influence_the_target() {
        let head = "CONNECT github.com:443 HTTP/1.1\r\n\
                    Host: evil.example:443\r\n\
                    Proxy-Authorization: Basic dXNlcjpwYXNz\r\n\
                    X-Forwarded-Host: evil.example\r\n\r\n";
        assert_eq!(parse(head), connect("github.com", 443));
    }

    #[test]
    fn ports() {
        assert_eq!(
            parse("CONNECT a.example:1 HTTP/1.1\r\n\r\n"),
            connect("a.example", 1)
        );
        assert_eq!(
            parse("CONNECT a.example:65535 HTTP/1.1\r\n\r\n"),
            connect("a.example", 65535)
        );
        for t in [
            "a.example",
            "a.example:",
            "a.example:0",
            "a.example:65536",
            "a.example:99999",
            "a.example:123456",
            "a.example:-1",
            "a.example:+443",
            "a.example:0443",
            "a.example:44a",
            "a.example:https",
            "a.example:443/",
            "a.example:443?x",
        ] {
            let r = parse(&format!("CONNECT {t} HTTP/1.1\r\n\r\n"));
            assert!(is_bad(&r), "{t}: {r:?}");
        }
    }

    #[test]
    fn ip_literal_targets_are_rejected_as_ip_literals() {
        for t in [
            "127.0.0.1:443",
            "1.1.1.1:443",
            "169.254.169.254:80",
            "127.1:443",
            "0x7f.1:443",
            "0x7f000001:443",
            "0X7F.0.0.1:443",
            "0177.0.0.1:443",
            "2130706433:443",
            "0:443",
            "127.0.0.1.:443",
            "[::1]:443",
            "[::]:443",
            "[::ffff:127.0.0.1]:443",
            "[::ffff:7f00:1]:443",
            "[fe80::1%25eth0]:443",
            "[2606:4700:4700::1111]:443",
            "[]:443",
            "[not-even-an-ip]:443",
            // unbracketed IPv6: rsplit leaves colons in the host part
            "::1:443",
            "::ffff:127.0.0.1:443",
            "2606:4700:4700::1111:443",
        ] {
            let r = parse(&format!("CONNECT {t} HTTP/1.1\r\n\r\n"));
            assert!(matches!(r, Err(Rejection::IpLiteral { .. })), "{t}: {r:?}");
        }
        assert_eq!(
            parse("CONNECT [::1]:8443 HTTP/1.1\r\n\r\n"),
            Err(Rejection::IpLiteral {
                host: "[::1]".into(),
                port: 8443
            })
        );
        assert_eq!(
            parse("CONNECT 0x7f.1:443 HTTP/1.1\r\n\r\n"),
            Err(Rejection::IpLiteral {
                host: "0x7f.1".into(),
                port: 443
            })
        );
    }

    #[test]
    fn malformed_bracket_targets() {
        for t in [
            "[::1]",
            "[::1",
            "[::1]443",
            "[::1]:",
            "[::1]:0",
            "[::1]x:443",
        ] {
            let r = parse(&format!("CONNECT {t} HTTP/1.1\r\n\r\n"));
            assert!(is_bad(&r), "{t}: {r:?}");
        }
    }

    #[test]
    fn malformed_connect_targets() {
        for t in [
            ":443",
            ".:443",
            "..:443",
            "a..b:443",
            "user@github.com:443",
            "https://github.com:443/",
            "github.com/:443",
            "github.com:443/path",
            "github.com#:443",
            "github.com?:443",
            "git_hub.com:443",
            "-github.com:443",
            "github-.com:443",
            "*.github.com:443",
            "*:443",
            "exa%6dple.com:443",
            "github.com\\:443",
            "github.com,evil.example:443",
            "github.com;evil.example:443",
        ] {
            let r = parse(&format!("CONNECT {t} HTTP/1.1\r\n\r\n"));
            assert!(is_bad(&r), "{t}: {r:?}");
        }
        let long = format!("CONNECT {}.com:443 HTTP/1.1\r\n\r\n", "a".repeat(64));
        assert!(is_bad(&parse(&long)));
    }

    #[test]
    fn userinfo_and_scheme_tricks_never_yield_a_connect() {
        // These contain extra colons, so they are refused either as malformed
        // or as an (IPv6-looking) literal; what matters is that no spelling
        // produces a Connect to either host.
        for t in [
            "user:pw@github.com:443",
            "github.com:443@evil.example:443",
            "evil.example:443@github.com:443",
            "http://github.com:443",
            "github.com:443:443",
            "github.com:443#@evil.example:443",
        ] {
            let r = parse(&format!("CONNECT {t} HTTP/1.1\r\n\r\n"));
            assert!(
                matches!(
                    r,
                    Err(Rejection::BadRequest(_)) | Err(Rejection::IpLiteral { .. })
                ),
                "{t}: {r:?}"
            );
        }
    }

    #[test]
    fn malformed_request_lines() {
        for head in [
            "\r\n\r\n",
            " \r\n\r\n",
            "CONNECT\r\n\r\n",
            "CONNECT github.com:443\r\n\r\n",
            "CONNECT  github.com:443 HTTP/1.1\r\n\r\n",
            "CONNECT github.com:443  HTTP/1.1\r\n\r\n",
            " CONNECT github.com:443 HTTP/1.1\r\n\r\n",
            "CONNECT github.com:443 HTTP/1.1 \r\n\r\n",
            "CONNECT github.com:443 HTTP/1.1 extra\r\n\r\n",
            "CONNECT\tgithub.com:443\tHTTP/1.1\r\n\r\n",
            "CONNECT github.com:443 HTTP/2\r\n\r\n",
            "CONNECT github.com:443 HTTP/2.0\r\n\r\n",
            "CONNECT github.com:443 HTTP/1.2\r\n\r\n",
            "CONNECT github.com:443 HTTP/0.9\r\n\r\n",
            "CONNECT github.com:443 http/1.1\r\n\r\n",
            "CONNECT github.com:443 HTTP/1.1x\r\n\r\n",
            "PRI * HTTP/2.0\r\n\r\n",
            "CON NECT github.com:443 HTTP/1.1\r\n\r\n",
            "CONNECT(1) github.com:443 HTTP/1.1\r\n\r\n",
            "CONNECT: github.com:443 HTTP/1.1\r\n\r\n",
            "\r\nCONNECT github.com:443 HTTP/1.1\r\n\r\n",
            "CONNECT github.com:443 HTTP/1.1\nHost: x\r\n\r\n",
            "CONNECT github.com:443 HTTP/1.1\rHost: x\r\n\r\n",
            "CONNECT github.com:443\nHTTP/1.1\r\n\r\n",
        ] {
            let r = parse(head);
            assert!(is_bad(&r), "{head:?}: {r:?}");
        }
    }

    #[test]
    fn unterminated_heads() {
        for head in [
            "",
            "CONNECT github.com:443 HTTP/1.1",
            "CONNECT github.com:443 HTTP/1.1\r\n",
            "CONNECT github.com:443 HTTP/1.1\r\n\r",
            "CONNECT github.com:443 HTTP/1.1\n\n",
            "CONNECT github.com:443 HTTP/1.1\r\n\n",
            "CONNECT github.com:443 HTTP/1.1\n\r\n",
        ] {
            let r = parse(head);
            assert!(is_bad(&r), "{head:?}: {r:?}");
        }
    }

    #[test]
    fn data_after_the_terminator_is_not_a_valid_head() {
        // parse_head must be given exactly the head; a second request glued on
        // is never interpreted.
        let r = parse(
            "CONNECT github.com:443 HTTP/1.1\r\n\r\nCONNECT evil.example:443 HTTP/1.1\r\n\r\n",
        );
        assert!(is_bad(&r), "{r:?}");
    }

    #[test]
    fn malformed_headers() {
        for hdr in [
            "NoColon",
            ": empty-name",
            " Leading: space",
            "\tLeading: tab",
            "Bad Name: x",
            "Bad\tName: x",
            "Name : x",
            "Na(me: x",
            "Host: a\r\n continued",
            "Host: a\r\n\tcontinued",
            "X: a\rb",
            "X: a\nb",
        ] {
            let head = format!("CONNECT github.com:443 HTTP/1.1\r\n{hdr}\r\n\r\n");
            let r = parse(&head);
            assert!(is_bad(&r), "{hdr:?}: {r:?}");
        }
    }

    #[test]
    fn control_and_non_ascii_bytes() {
        let mut nul = b"CONNECT github.com:443 HTTP/1.1\r\nX: a".to_vec();
        nul.push(0);
        nul.extend_from_slice(b"b\r\n\r\n");
        assert!(is_bad(&parse_head(&nul)));

        for b in [0x00u8, 0x01, 0x08, 0x0b, 0x0c, 0x1b, 0x7f, 0x80, 0xc3, 0xff] {
            let mut head = b"CONNECT github.com".to_vec();
            head.push(b);
            head.extend_from_slice(b":443 HTTP/1.1\r\n\r\n");
            assert!(is_bad(&parse_head(&head)), "byte {b:#x} in target");

            let mut head = b"CONNECT github.com:443 HTTP/1.1\r\nX-H: v".to_vec();
            head.push(b);
            head.extend_from_slice(b"\r\n\r\n");
            assert!(is_bad(&parse_head(&head)), "byte {b:#x} in header");
        }
        // Unicode look-alike host.
        assert!(is_bad(&parse("CONNECT gíthub.com:443 HTTP/1.1\r\n\r\n")));
        // HTAB is fine inside a header value.
        assert_eq!(
            parse("CONNECT github.com:443 HTTP/1.1\r\nX: a\tb\r\n\r\n"),
            connect("github.com", 443)
        );
    }

    #[test]
    fn health_check() {
        assert_eq!(parse("GET /healthz HTTP/1.1\r\n\r\n"), Ok(Request::Health));
        assert_eq!(
            parse("GET /healthz HTTP/1.0\r\nHost: localhost:3128\r\n\r\n"),
            Ok(Request::Health)
        );
    }

    #[test]
    fn everything_else_is_method_not_allowed() {
        for (method, target) in [
            ("GET", "http://example.com/"),
            ("GET", "http://example.com/healthz"),
            ("GET", "http://github.com/"),
            ("GET", "/"),
            ("GET", "/healthz/"),
            ("GET", "/healthz?x=1"),
            ("GET", "/HEALTHZ"),
            ("GET", "//healthz"),
            ("GET", "github.com:443"),
            ("HEAD", "/healthz"),
            ("POST", "/healthz"),
            ("POST", "http://example.com/"),
            ("PUT", "http://example.com/x"),
            ("DELETE", "http://example.com/x"),
            ("OPTIONS", "*"),
            ("TRACE", "/"),
            ("PATCH", "/"),
            ("connect", "github.com:443"),
            ("Connect", "github.com:443"),
            ("CONNECTX", "github.com:443"),
            ("get", "/healthz"),
        ] {
            let r = parse(&format!("{method} {target} HTTP/1.1\r\nHost: x\r\n\r\n"));
            assert_eq!(
                r,
                Err(Rejection::MethodNotAllowed {
                    method: method.to_string(),
                    target: target.to_string()
                }),
                "{method} {target}"
            );
        }
    }

    #[test]
    fn oversized_heads() {
        let line = "CONNECT github.com:443 HTTP/1.1\r\n";
        // Exactly at the limit: accepted.
        let overhead = line.len() + "X-Pad: ".len() + 2 + 2;
        let pad = "a".repeat(MAX_HEAD_BYTES - overhead);
        let at_limit = format!("{line}X-Pad: {pad}\r\n\r\n");
        assert_eq!(at_limit.len(), MAX_HEAD_BYTES);
        assert_eq!(parse(&at_limit), connect("github.com", 443));
        // One byte over: rejected.
        let over = format!("{line}X-Pad: {pad}a\r\n\r\n");
        assert_eq!(over.len(), MAX_HEAD_BYTES + 1);
        assert_eq!(
            parse(&over),
            Err(Rejection::BadRequest("request head too large"))
        );
        // Way over.
        let huge = format!("{line}X-Pad: {}\r\n\r\n", "a".repeat(1 << 20));
        assert!(is_bad(&parse(&huge)));
        // An over-long request line on its own.
        let long_target = format!("GET /{} HTTP/1.1\r\n\r\n", "a".repeat(MAX_HEAD_BYTES));
        assert!(is_bad(&parse(&long_target)));
    }

    #[test]
    fn many_headers_within_the_limit_are_fine() {
        let mut head = String::from("CONNECT github.com:443 HTTP/1.1\r\n");
        for i in 0..200 {
            head.push_str(&format!("X-{i}: v\r\n"));
        }
        head.push_str("\r\n");
        assert!(head.len() < MAX_HEAD_BYTES);
        assert_eq!(parse(&head), connect("github.com", 443));
    }
}
