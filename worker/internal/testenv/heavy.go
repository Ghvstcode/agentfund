// Package testenv holds dependency-free helpers describing the test environment.
package testenv

import "testing"

// SkipIfHeavyKDF skips tests that derive a key with minisign's default
// scrypt parameters (N = 2^20, r = 8: one gibibyte of memory, touched
// randomly). Under the race detector every one of those accesses is shadowed,
// which multiplies the footprint several times over and gets the test binary
// OOM-killed on a 7 GB CI runner. The same code paths are covered with small
// KDF parameters by tests that always run.
func SkipIfHeavyKDF(t testing.TB) {
	t.Helper()
	if testing.Short() {
		t.Skip("scrypt with minisign's default parameters needs 1 GiB and several seconds (-short)")
	}
	if RaceEnabled {
		t.Skip("scrypt with minisign's default parameters (1 GiB) is not run under the race detector; the small-parameter tests cover the same code")
	}
}
