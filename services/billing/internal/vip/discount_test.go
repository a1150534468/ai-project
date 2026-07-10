package vip

import "testing"

func TestDiscountedPoints(t *testing.T) {
	cases := []struct {
		name        string
		original    int64
		discountBps int
		want        int64
	}{
		{name: "zero original", original: 0, discountBps: 9000, want: 0},
		{name: "full price", original: 123, discountBps: 10000, want: 123},
		{name: "round up", original: 101, discountBps: 9000, want: 91},
		{name: "minimum one point", original: 3, discountBps: 1, want: 1},
		{name: "invalid discount still one point", original: 5, discountBps: 0, want: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := DiscountedPoints(tc.original, tc.discountBps); got != tc.want {
				t.Fatalf("DiscountedPoints(%d, %d)=%d, want %d", tc.original, tc.discountBps, got, tc.want)
			}
		})
	}
}
