package billingmode

import "testing"

func TestParse(t *testing.T) {
	tests := []struct {
		raw  string
		want Mode
		err  bool
	}{
		{raw: "", want: Standard},
		{raw: "standard", want: Standard},
		{raw: " learning ", want: Learning},
		{raw: "fixed", err: true},
	}
	for _, tt := range tests {
		got, err := Parse(tt.raw)
		if (err != nil) != tt.err {
			t.Fatalf("Parse(%q) err=%v, wantErr=%v", tt.raw, err, tt.err)
		}
		if !tt.err && got != tt.want {
			t.Fatalf("Parse(%q)=%q, want %q", tt.raw, got, tt.want)
		}
	}
}

func TestNormalizeCost(t *testing.T) {
	if got := Standard.NormalizeCost(37); got != 37 {
		t.Fatalf("standard cost=%d, want 37", got)
	}
	for _, input := range []int64{0, 1, 37, 999999} {
		if got := Learning.NormalizeCost(input); got != 1 {
			t.Fatalf("learning cost for %d=%d, want 1", input, got)
		}
	}
}
