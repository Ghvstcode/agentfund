//! Egress allowlist proxy for the AgentFund sandbox.
//!
//! The crate is split so that every security decision lives in pure,
//! exhaustively unit-tested code, and the I/O layer only wires them together:
//!
//! * [`host`]      – hostname normalisation and IP-literal detection (pure)
//! * [`allowlist`] – `ALLOW_HOSTS` parsing and matching (pure)
//! * [`ipclass`]   – classification of resolved addresses (pure)
//! * [`request`]   – request-head parsing (pure)
//! * [`config`]    – environment parsing (pure, lookup function injected)
//! * [`log`]       – JSON line encoding and sinks
//! * [`proxy`]     – the TCP server (I/O)

#![forbid(unsafe_code)]

pub mod allowlist;
pub mod config;
pub mod host;
pub mod ipclass;
pub mod log;
pub mod proxy;
pub mod request;
