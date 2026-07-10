package resource

import (
	"testing"

	"yc-billing/internal/model"
	"yc-billing/internal/videopoint"
)

// TestQuoteVideoIO 覆盖复合计价：cost = 输入秒 × 输入单价 + 输出秒 × 输出单价（ceil）。
func TestQuoteVideoIO(t *testing.T) {
	st := newStore(t)
	s := New(st)
	// 输入单价 2 视频点/秒，输出单价 5 视频点/秒。
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "video_seedance_2_720p_with_video", DisplayName: "有输入视频",
		PricingType: "VIDEO_IO", Rate: 2, OutputRate: 5, PerUnits: 1, Enabled: true,
	}).Error; err != nil {
		t.Fatalf("create video_io price: %v", err)
	}
	// 历史遗留 PER_UNIT（管理员未改配），按旧口径仅输出秒 × Rate 计价。
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "video_legacy_with_video", DisplayName: "遗留",
		PricingType: "PER_UNIT", Rate: 3, PerUnits: 1, Enabled: true,
	}).Error; err != nil {
		t.Fatalf("create legacy price: %v", err)
	}

	cases := []struct {
		name      string
		key       string
		inputSec  int64
		outputSec int64
		want      int64
	}{
		{"复合计价", "video_seedance_2_720p_with_video", 6, 8, 6*2 + 8*5},         // 52
		{"输入为零退化为纯输出", "video_seedance_2_720p_with_video", 0, 10, 0*2 + 10*5}, // 50
		{"负输入按零处理", "video_seedance_2_720p_with_video", -3, 4, 0*2 + 4*5},     // 20
		{"遗留 PER_UNIT 仅按输出", "video_legacy_with_video", 100, 5, 5 * 3},        // 15，忽略输入秒
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := s.QuoteVideoIO(tc.key, tc.inputSec, tc.outputSec)
			if err != nil {
				t.Fatalf("QuoteVideoIO err: %v", err)
			}
			if got != tc.want {
				t.Fatalf("QuoteVideoIO(%s, %d, %d) = %d, want %d", tc.key, tc.inputSec, tc.outputSec, got, tc.want)
			}
		})
	}

	// ceil 取整：小数单价须向上取整。
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "video_frac_with_video", DisplayName: "小数",
		PricingType: "VIDEO_IO", Rate: 0.3, OutputRate: 0.4, PerUnits: 1, Enabled: true,
	}).Error; err != nil {
		t.Fatalf("create frac price: %v", err)
	}
	if got, _ := s.QuoteVideoIO("video_frac_with_video", 5, 5); got != 4 { // ceil(1.5+2.0)=ceil(3.5)=4
		t.Fatalf("frac quote want 4 got %d", got)
	}

	// 未配置/停用返回 ErrResourceNotPriced。
	if _, err := s.QuoteVideoIO("video_not_exist", 1, 1); err != ErrResourceNotPriced {
		t.Fatalf("missing key want ErrResourceNotPriced got %v", err)
	}
}

// TestChargeVideoIO 校验按复合成本扣视频点，且 operationId 幂等。
func TestChargeVideoIO(t *testing.T) {
	st := newStore(t)
	s := New(st)
	const uid = "u-videoio"
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "video_seedance_2_720p_with_video", DisplayName: "有输入视频",
		PricingType: "VIDEO_IO", Rate: 2, OutputRate: 5, PerUnits: 1, Enabled: true,
	}).Error; err != nil {
		t.Fatalf("create price: %v", err)
	}
	// 预存足额视频点。
	if err := videopoint.CreditInTx(st.DB, uid, 1000); err != nil {
		t.Fatalf("credit video points: %v", err)
	}

	cost, err := s.ChargeVideoIO("video:req-1", uid, "video_seedance_2_720p_with_video", 6, 8)
	if err != nil {
		t.Fatalf("ChargeVideoIO err: %v", err)
	}
	if cost != 52 {
		t.Fatalf("charge cost want 52 got %d", cost)
	}
	// 相同 operationId 重复扣费应幂等（不重复扣）。
	cost2, err := s.ChargeVideoIO("video:req-1", uid, "video_seedance_2_720p_with_video", 6, 8)
	if err != nil {
		t.Fatalf("idempotent charge err: %v", err)
	}
	if cost2 != 52 {
		t.Fatalf("idempotent cost want 52 got %d", cost2)
	}
	bal, err := videopoint.Balance(st.DB, uid)
	if err != nil {
		t.Fatalf("balance err: %v", err)
	}
	if bal != 1000-52 {
		t.Fatalf("balance want %d got %d", 1000-52, bal)
	}
}
