//! Classification of resolved upstream addresses. Pure; no I/O.
//!
//! This is the DNS-rebinding / SSRF guard: after an allowlisted name has been
//! resolved, every candidate address goes through [`blocked_reason`] and the
//! proxy only ever connects to addresses for which it returns `None`.
//!
//! The IPv4 side is a deny-list of every special-purpose range. The IPv6 side
//! is an allow-list: only global unicast (`2000::/3`, minus its special
//! carve-outs) is permitted, plus IPv4-mapped / NAT64 addresses whose embedded
//! IPv4 address is itself public.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// `None` if `ip` is a publicly routable unicast address the proxy may connect
/// to; otherwise a short label for the range that blocks it.
pub fn blocked_reason(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(a) => v4_blocked(a),
        IpAddr::V6(a) => v6_blocked(a),
    }
}

/// Convenience inverse of [`blocked_reason`].
pub fn is_public(ip: IpAddr) -> bool {
    blocked_reason(ip).is_none()
}

fn v4_blocked(a: Ipv4Addr) -> Option<&'static str> {
    let [o1, o2, o3, _] = a.octets();
    let reason = match (o1, o2, o3) {
        (0, _, _) => "unspecified",                 // 0.0.0.0/8
        (10, _, _) => "private",                    // 10.0.0.0/8
        (100, 64..=127, _) => "cgnat",              // 100.64.0.0/10
        (127, _, _) => "loopback",                  // 127.0.0.0/8
        (169, 254, _) => "link-local",              // 169.254.0.0/16 (metadata)
        (172, 16..=31, _) => "private",             // 172.16.0.0/12
        (192, 0, 0) => "ietf-protocol-assignments", // 192.0.0.0/24
        (192, 0, 2) => "documentation",             // 192.0.2.0/24
        (192, 88, 99) => "6to4-relay",              // 192.88.99.0/24
        (192, 168, _) => "private",                 // 192.168.0.0/16
        (198, 18..=19, _) => "benchmarking",        // 198.18.0.0/15
        (198, 51, 100) => "documentation",          // 198.51.100.0/24
        (203, 0, 113) => "documentation",           // 203.0.113.0/24
        (224..=239, _, _) => "multicast",           // 224.0.0.0/4
        (240..=255, _, _) => "reserved",            // 240.0.0.0/4 incl. broadcast
        _ => return None,
    };
    Some(reason)
}

fn v6_blocked(a: Ipv6Addr) -> Option<&'static str> {
    let s = a.segments();
    if a.is_unspecified() {
        return Some("unspecified");
    }
    if a.is_loopback() {
        return Some("loopback");
    }
    // ::ffff:a.b.c.d — the kernel connects these over IPv4.
    if let Some(v4) = a.to_ipv4_mapped() {
        return v4_blocked(v4);
    }
    // 64:ff9b::/96 — well-known NAT64 prefix; a gateway translates to the
    // embedded IPv4 address.
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
        return v4_blocked(embedded_v4(s[6], s[7]));
    }
    // Everything outside global unicast 2000::/3.
    if s[0] & 0xe000 != 0x2000 {
        return Some(if s[0] & 0xfe00 == 0xfc00 {
            "unique-local" // fc00::/7
        } else if s[0] & 0xffc0 == 0xfe80 {
            "link-local" // fe80::/10
        } else if s[0] & 0xffc0 == 0xfec0 {
            "site-local" // fec0::/10 (deprecated)
        } else if s[0] & 0xff00 == 0xff00 {
            "multicast" // ff00::/8
        } else {
            // ::/96 IPv4-compatible, 64:ff9b:1::/48, 100::/64 discard, and
            // all unallocated space.
            "non-global"
        });
    }
    // Special-purpose carve-outs inside 2000::/3.
    if s[0] == 0x2001 && s[1] < 0x0200 {
        return Some("ietf-protocol-assignments"); // 2001::/23 incl. Teredo
    }
    if s[0] == 0x2001 && s[1] == 0x0db8 {
        return Some("documentation"); // 2001:db8::/32
    }
    if s[0] == 0x2002 {
        return Some("6to4"); // 2002::/16 embeds arbitrary IPv4
    }
    if s[0] == 0x3fff && s[1] < 0x1000 {
        return Some("documentation"); // 3fff::/20
    }
    None
}

fn embedded_v4(hi: u16, lo: u16) -> Ipv4Addr {
    Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap_or_else(|_| panic!("bad test ip {s}"))
    }

    fn assert_blocked(s: &str, want: &str) {
        assert_eq!(blocked_reason(ip(s)), Some(want), "{s}");
        assert!(!is_public(ip(s)), "{s}");
    }

    fn assert_public(s: &str) {
        assert_eq!(blocked_reason(ip(s)), None, "{s}");
        assert!(is_public(ip(s)), "{s}");
    }

    #[test]
    fn v4_this_network() {
        assert_blocked("0.0.0.0", "unspecified");
        assert_blocked("0.0.0.1", "unspecified");
        assert_blocked("0.255.255.255", "unspecified");
        assert_public("1.0.0.0");
    }

    #[test]
    fn v4_rfc1918_10() {
        assert_public("9.255.255.255");
        assert_blocked("10.0.0.0", "private");
        assert_blocked("10.0.0.1", "private");
        assert_blocked("10.255.255.255", "private");
        assert_public("11.0.0.0");
    }

    #[test]
    fn v4_cgnat() {
        assert_public("100.63.255.255");
        assert_blocked("100.64.0.0", "cgnat");
        assert_blocked("100.100.100.100", "cgnat");
        assert_blocked("100.127.255.255", "cgnat");
        assert_public("100.128.0.0");
    }

    #[test]
    fn v4_loopback() {
        assert_public("126.255.255.255");
        assert_blocked("127.0.0.0", "loopback");
        assert_blocked("127.0.0.1", "loopback");
        assert_blocked("127.0.0.11", "loopback"); // Docker embedded DNS
        assert_blocked("127.255.255.255", "loopback");
        assert_public("128.0.0.0");
    }

    #[test]
    fn v4_link_local_and_metadata() {
        assert_public("169.253.255.255");
        assert_blocked("169.254.0.0", "link-local");
        assert_blocked("169.254.169.254", "link-local");
        assert_blocked("169.254.170.2", "link-local"); // ECS task metadata
        assert_blocked("169.254.255.255", "link-local");
        assert_public("169.255.0.0");
    }

    #[test]
    fn v4_rfc1918_172() {
        assert_public("172.15.255.255");
        assert_blocked("172.16.0.0", "private");
        assert_blocked("172.17.0.1", "private"); // default docker bridge gateway
        assert_blocked("172.31.255.255", "private");
        assert_public("172.32.0.0");
    }

    #[test]
    fn v4_192_0_special() {
        assert_public("191.255.255.255");
        assert_blocked("192.0.0.0", "ietf-protocol-assignments");
        assert_blocked("192.0.0.255", "ietf-protocol-assignments");
        assert_public("192.0.1.0");
        assert_public("192.0.1.255");
        assert_blocked("192.0.2.0", "documentation");
        assert_blocked("192.0.2.255", "documentation");
        assert_public("192.0.3.0");
    }

    #[test]
    fn v4_6to4_relay() {
        assert_public("192.88.98.255");
        assert_blocked("192.88.99.0", "6to4-relay");
        assert_blocked("192.88.99.255", "6to4-relay");
        assert_public("192.88.100.0");
    }

    #[test]
    fn v4_rfc1918_192_168() {
        assert_public("192.167.255.255");
        assert_blocked("192.168.0.0", "private");
        assert_blocked("192.168.1.1", "private");
        assert_blocked("192.168.255.255", "private");
        assert_public("192.169.0.0");
    }

    #[test]
    fn v4_benchmarking() {
        assert_public("198.17.255.255");
        assert_blocked("198.18.0.0", "benchmarking");
        assert_blocked("198.19.255.255", "benchmarking");
        assert_public("198.20.0.0");
    }

    #[test]
    fn v4_documentation() {
        assert_public("198.51.99.255");
        assert_blocked("198.51.100.0", "documentation");
        assert_blocked("198.51.100.255", "documentation");
        assert_public("198.51.101.0");
        assert_public("203.0.112.255");
        assert_blocked("203.0.113.0", "documentation");
        assert_blocked("203.0.113.255", "documentation");
        assert_public("203.0.114.0");
    }

    #[test]
    fn v4_multicast_reserved_broadcast() {
        assert_public("223.255.255.255");
        assert_blocked("224.0.0.0", "multicast");
        assert_blocked("224.0.0.251", "multicast");
        assert_blocked("239.255.255.255", "multicast");
        assert_blocked("240.0.0.0", "reserved");
        assert_blocked("255.255.255.254", "reserved");
        assert_blocked("255.255.255.255", "reserved");
    }

    #[test]
    fn v4_ordinary_public_addresses() {
        for s in [
            "1.1.1.1",
            "8.8.8.8",
            "140.82.112.3",
            "160.79.104.10",
            "104.16.0.1",
            "172.64.0.1",
            "192.30.255.113",
            "100.0.0.1",
            "169.1.1.1",
            "198.41.0.4",
        ] {
            assert_public(s);
        }
    }

    #[test]
    fn v6_unspecified_and_loopback() {
        assert_blocked("::", "unspecified");
        assert_blocked("::1", "loopback");
        assert_blocked("0:0:0:0:0:0:0:1", "loopback");
    }

    #[test]
    fn v6_ipv4_mapped_follows_the_embedded_address() {
        assert_blocked("::ffff:127.0.0.1", "loopback");
        assert_blocked("::ffff:7f00:1", "loopback");
        assert_blocked("::ffff:10.0.0.1", "private");
        assert_blocked("::ffff:172.16.0.1", "private");
        assert_blocked("::ffff:192.168.1.1", "private");
        assert_blocked("::ffff:169.254.169.254", "link-local");
        assert_blocked("::ffff:a9fe:a9fe", "link-local");
        assert_blocked("::ffff:100.64.0.1", "cgnat");
        assert_blocked("::ffff:0.0.0.0", "unspecified");
        assert_blocked("::ffff:224.0.0.1", "multicast");
        assert_blocked("::ffff:255.255.255.255", "reserved");
        assert_public("::ffff:1.1.1.1");
        assert_public("::ffff:8.8.8.8");
    }

    #[test]
    fn v6_ipv4_compatible_and_low_space_is_blocked() {
        assert_blocked("::127.0.0.1", "non-global");
        assert_blocked("::1.1.1.1", "non-global");
        assert_blocked("::2", "non-global");
        assert_blocked("::ffff:0:0:1", "non-global"); // not the mapped prefix
        assert_blocked("::fffe:1.1.1.1", "non-global");
        assert_blocked("100::1", "non-global"); // discard-only
        assert_blocked("1::1", "non-global");
        assert_blocked("1fff:ffff::1", "non-global");
    }

    #[test]
    fn v6_nat64_follows_the_embedded_address() {
        assert_blocked("64:ff9b::127.0.0.1", "loopback");
        assert_blocked("64:ff9b::10.0.0.1", "private");
        assert_blocked("64:ff9b::169.254.169.254", "link-local");
        assert_blocked("64:ff9b::c0a8:101", "private");
        assert_public("64:ff9b::1.1.1.1");
        assert_public("64:ff9b::8c52:7003");
        // Local-use NAT64 and anything else near the prefix is not global.
        assert_blocked("64:ff9b:1::1.1.1.1", "non-global");
        assert_blocked("64:ff9b:0:1::1.1.1.1", "non-global");
        assert_blocked("64:ff9a::1.1.1.1", "non-global");
        assert_blocked("65:ff9b::1.1.1.1", "non-global");
    }

    #[test]
    fn v6_unique_local() {
        assert_blocked("fbff:ffff::1", "non-global");
        assert_blocked("fc00::", "unique-local");
        assert_blocked("fc00::1", "unique-local");
        assert_blocked("fd00::1", "unique-local");
        assert_blocked("fd12:3456:789a::1", "unique-local");
        assert_blocked("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "unique-local");
        assert_blocked("fe00::1", "non-global");
    }

    #[test]
    fn v6_link_local_and_site_local() {
        assert_blocked("fe7f:ffff::1", "non-global");
        assert_blocked("fe80::", "link-local");
        assert_blocked("fe80::1", "link-local");
        assert_blocked("febf:ffff::1", "link-local");
        assert_blocked("fec0::", "site-local");
        assert_blocked("fec0::1", "site-local");
        assert_blocked("feff:ffff::1", "site-local");
    }

    #[test]
    fn v6_multicast() {
        assert_blocked("ff00::", "multicast");
        assert_blocked("ff02::1", "multicast");
        assert_blocked("ff0e::1", "multicast");
        assert_blocked("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "multicast");
    }

    #[test]
    fn v6_global_unicast_boundaries() {
        assert_blocked("1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "non-global");
        assert_public("2000::1");
        assert_public("3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
        assert_blocked("4000::", "non-global");
        assert_blocked("4000::1", "non-global");
        assert_blocked("8000::1", "non-global");
        assert_blocked("e000::1", "non-global");
    }

    #[test]
    fn v6_special_ranges_inside_global_unicast() {
        // 2001::/23 (Teredo 2001::/32, ORCHIDv2, benchmarking, ...)
        assert_blocked("2001::", "ietf-protocol-assignments");
        assert_blocked("2001::1", "ietf-protocol-assignments");
        assert_blocked(
            "2001:0:4136:e378:8000:63bf:3fff:fdd2",
            "ietf-protocol-assignments",
        );
        assert_blocked("2001:2::1", "ietf-protocol-assignments");
        assert_blocked("2001:20::1", "ietf-protocol-assignments");
        assert_blocked("2001:1ff:ffff::1", "ietf-protocol-assignments");
        assert_public("2001:200::1");
        // documentation 2001:db8::/32
        assert_public("2001:db7:ffff::1");
        assert_blocked("2001:db8::", "documentation");
        assert_blocked("2001:db8::1", "documentation");
        assert_blocked("2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", "documentation");
        assert_public("2001:db9::1");
        // 6to4 2002::/16
        assert_public("2001:ffff:ffff::1");
        assert_blocked("2002::", "6to4");
        assert_blocked("2002:7f00:1::1", "6to4");
        assert_blocked("2002:101:101::1", "6to4");
        assert_blocked("2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "6to4");
        assert_public("2003::1");
        // documentation 3fff::/20
        assert_public("3ffe::1");
        assert_blocked("3fff::1", "documentation");
        assert_blocked("3fff:fff:ffff::1", "documentation");
        assert_public("3fff:1000::1");
    }

    #[test]
    fn v6_ordinary_public_addresses() {
        for s in [
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "2a00:1450:4001:81b::200e",
            "2620:1ec:21::14",
            "2607:6bc0::10",
        ] {
            assert_public(s);
        }
    }

    #[test]
    fn exhaustive_v4_first_two_octets_agree_with_reference_ranges() {
        // Independent re-statement of the blocked ranges as (base, prefix)
        // pairs, checked against every /16 and the third octets at which any
        // /24-granular range begins or ends.
        const BLOCKED: &[(u32, u32)] = &[
            (0x0000_0000, 8),
            (0x0a00_0000, 8),
            (0x6440_0000, 10),
            (0x7f00_0000, 8),
            (0xa9fe_0000, 16),
            (0xac10_0000, 12),
            (0xc000_0000, 24),
            (0xc000_0200, 24),
            (0xc058_6300, 24),
            (0xc0a8_0000, 16),
            (0xc612_0000, 15),
            (0xc633_6400, 24),
            (0xcb00_7100, 24),
            (0xe000_0000, 4),
            (0xf000_0000, 4),
        ];
        let in_blocked = |addr: u32| {
            BLOCKED
                .iter()
                .any(|&(base, len)| (addr ^ base) >> (32 - len) == 0)
        };
        const THIRD: &[u32] = &[0, 1, 2, 3, 98, 99, 100, 101, 112, 113, 114, 254, 255];
        for hi in 0u32..=0xffff {
            for &third in THIRD {
                for last in [0u32, 1, 255] {
                    let addr = (hi << 16) | (third << 8) | last;
                    let got = !is_public(IpAddr::V4(Ipv4Addr::from(addr)));
                    assert_eq!(got, in_blocked(addr), "{}", Ipv4Addr::from(addr));
                }
            }
        }
    }
}
