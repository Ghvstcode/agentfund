package tokfmt

import "testing"

func TestFormat(t *testing.T) {
	for n, want := range map[int64]string{
		0: "0", 7: "7", 999: "999", 1000: "1k", 1500: "1.5k", 8250: "8,250", 750_000: "750k", 1_000_000: "1M",
		1_500_000: "1.5M", 5_000_000: "5M", 10_000_000: "10M", 1_234_567: "1,234,567", 2_000_000_000: "2G",
		1_050_000: "1.05M", 1_000_500: "1,000,500", 1_500_000_000: "1.5G", 999_900: "999.9k", 200_000_000: "200M", -8250: "-8,250",
	} {
		if got := Format(n); got != want {
			t.Errorf("Format(%d) = %q, want %q", n, got, want)
		}
	}
	if Exact(10_000_000) != "10,000,000" || Compact(8250) != "" {
		t.Error("Exact/Compact")
	}
}
