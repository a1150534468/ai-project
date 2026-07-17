package resource

import (
	"strconv"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"ai-assistant-billing/internal/billingmode"
	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/pgtest"
	"ai-assistant-billing/internal/store"
	"ai-assistant-billing/internal/videopoint"
	"ai-assistant-billing/internal/vip"
)

func TestLearningChargeIsOnePointIdempotentAndRefundable(t *testing.T) {
	st := newStore(t)
	s := NewWithPricingMode(st, billingmode.Learning)
	st.DB.Create(&model.ResourcePrice{ResourceKey: "image_generation", PricingType: "PER_UNIT", Rate: 40, PerUnits: 1, Enabled: true})
	if err := bucket.GrantPoints(st.DB, "learn-u1", 2, nil, bucket.SourceSystem); err != nil {
		t.Fatal(err)
	}

	charged, err := s.Charge("learn:image:1", "learn-u1", "image_generation", 4)
	if err != nil || charged != 1 {
		t.Fatalf("charge=%d err=%v, want 1", charged, err)
	}
	charged, err = s.Charge("learn:image:1", "learn-u1", "image_generation", 4)
	if err != nil || charged != 1 {
		t.Fatalf("replayed charge=%d err=%v, want 1", charged, err)
	}
	if got, _ := bucket.Balance(st.DB, "learn-u1"); got != 1 {
		t.Fatalf("balance=%d, want 1", got)
	}
	if err := s.RefundCharge("learn:image:1"); err != nil {
		t.Fatal(err)
	}
	if err := s.RefundCharge("learn:image:1"); err != nil {
		t.Fatal(err)
	}
	if got, _ := bucket.Balance(st.DB, "learn-u1"); got != 2 {
		t.Fatalf("refunded balance=%d, want 2", got)
	}
}

func TestLearningReserveSettleKeepsOnePoint(t *testing.T) {
	st := newStore(t)
	s := NewWithPricingMode(st, billingmode.Learning)
	st.DB.Create(&model.ResourcePrice{ResourceKey: "novel_text_output", PricingType: "PER_UNIT", Rate: 8, PerUnits: 1000, Enabled: true})
	if err := bucket.GrantPoints(st.DB, "learn-u2", 2, nil, bucket.SourceSystem); err != nil {
		t.Fatal(err)
	}

	reserved, err := s.Reserve("learn:novel:1", "learn-u2", "novel_text_output", 100000)
	if err != nil || reserved != 1 {
		t.Fatalf("reserved=%d err=%v, want 1", reserved, err)
	}
	settled, err := s.Settle("learn:novel:1", "novel_text_output", 90000)
	if err != nil || settled != 1 {
		t.Fatalf("settled=%d err=%v, want 1", settled, err)
	}
	if got, _ := bucket.Balance(st.DB, "learn-u2"); got != 1 {
		t.Fatalf("balance=%d, want 1", got)
	}
}

func TestLearningVideoUsesOneVideoPoint(t *testing.T) {
	st := newStore(t)
	s := NewWithPricingMode(st, billingmode.Learning)
	st.DB.Create(&model.ResourcePrice{ResourceKey: "video_learning", PricingType: "VIDEO_IO", Rate: 5, OutputRate: 10, PerUnits: 1, Enabled: true})
	if err := bucket.GrantPoints(st.DB, "learn-video", 100, nil, bucket.SourceSystem); err != nil {
		t.Fatal(err)
	}
	if err := videopoint.CreditInTx(st.DB, "learn-video", 2); err != nil {
		t.Fatal(err)
	}

	charged, err := s.ChargeVideoIO("learn:video:1", "learn-video", "video_learning", 30, 60)
	if err != nil || charged != 1 {
		t.Fatalf("charge=%d err=%v, want 1", charged, err)
	}
	settled, err := s.SettleVideoIO("learn:video:1", "video_learning", 30, 45)
	if err != nil || settled != 1 {
		t.Fatalf("settle=%d err=%v, want 1", settled, err)
	}
	if got, _ := bucket.Balance(st.DB, "learn-video"); got != 100 {
		t.Fatalf("points balance=%d, want unchanged 100", got)
	}
	if got, _ := videopoint.Balance(st.DB, "learn-video"); got != 1 {
		t.Fatalf("video balance=%d, want 1", got)
	}
	if err := s.RefundCharge("learn:video:1"); err != nil {
		t.Fatal(err)
	}
	if got, _ := videopoint.Balance(st.DB, "learn-video"); got != 2 {
		t.Fatalf("refunded video points=%d, want 2", got)
	}
}

func TestLearningStillRejectsUnknownResourceAndInsufficientBalance(t *testing.T) {
	st := newStore(t)
	s := NewWithPricingMode(st, billingmode.Learning)
	if _, err := s.Charge("learn:missing", "learn-empty", "missing", 1); err != ErrResourceNotPriced {
		t.Fatalf("missing resource err=%v, want ErrResourceNotPriced", err)
	}
	st.DB.Create(&model.ResourcePrice{ResourceKey: "known", PricingType: "PER_CALL", Rate: 50, PerUnits: 1, Enabled: true})
	if _, err := s.Charge("learn:402", "learn-empty", "known", 1); err != ErrInsufficient {
		t.Fatalf("empty balance err=%v, want ErrInsufficient", err)
	}
}

func newStore(t *testing.T) *store.Store {
	dsn := pgtest.DSN()
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Skipf("billing-postgres 不可用: %v", err)
	}
	if err := db.AutoMigrate(
		&model.ResourcePrice{},
		&model.PlatformConfig{},
		&model.PointBucket{},
		&model.VideoPointAccount{},
		&model.UsageRecord{},
		&model.VipLevel{},
		&model.UserVipState{},
		&model.VipGrowthLedger{},
	); err != nil {
		t.Fatalf("AutoMigrate failed: %v", err)
	}
	pgtest.Serialize(t, db)
	db.Exec("TRUNCATE vip_growth_ledgers, user_vip_states, vip_levels, resource_prices, platform_configs, point_buckets, video_point_accounts, usage_records CASCADE")
	if err := vip.New(db).EnsureDefaultLevels(100); err != nil {
		t.Fatalf("EnsureDefaultLevels failed: %v", err)
	}
	return &store.Store{DB: db}
}

func TestKbDefaultQuotaIsOneGiB(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if got := s.KbDefaultQuota(); got != 1024*1024*1024 {
		t.Fatalf("default KB quota=%d, want 1GiB", got)
	}
}

func TestQuote(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if err := st.DB.Create(&model.ResourcePrice{ResourceKey: "websearch", PricingType: "PER_CALL", Rate: 10, PerUnits: 1, Enabled: true}).Error; err != nil {
		t.Fatalf("create websearch: %v", err)
	}
	if err := st.DB.Create(&model.ResourcePrice{ResourceKey: "embedding", PricingType: "PER_UNIT", Rate: 0.2, PerUnits: 1000, Enabled: true}).Error; err != nil {
		t.Fatalf("create embedding: %v", err)
	}
	if err := st.DB.Create(&model.ResourcePrice{ResourceKey: "ocr", PricingType: "PER_UNIT", Rate: 5, PerUnits: 1, Enabled: true}).Error; err != nil {
		t.Fatalf("create ocr: %v", err)
	}
	if err := st.DB.Model(&model.ResourcePrice{}).Where("resource_key = ?", "ocr").Update("enabled", false).Error; err != nil {
		t.Fatalf("disable ocr: %v", err)
	}

	if q, _ := s.Quote("websearch", 1); q != 10 {
		t.Fatalf("websearch want 10 got %d", q)
	}
	if q, _ := s.Quote("embedding", 2500); q != 1 { // ceil(0.2*2500/1000)=ceil(0.5)=1
		t.Fatalf("embedding want 1 got %d", q)
	}
	if _, err := s.Quote("ocr", 3); err != ErrResourceNotPriced { // 停用
		t.Fatalf("disabled want ErrResourceNotPriced got %v", err)
	}
	if _, err := s.Quote("nope", 1); err != ErrResourceNotPriced {
		t.Fatalf("missing want ErrResourceNotPriced got %v", err)
	}
}

func TestChargeAndRefund(t *testing.T) {
	st := newStore(t)
	s := New(st)
	st.DB.Create(&model.ResourcePrice{ResourceKey: "websearch", PricingType: "PER_CALL", Rate: 10, PerUnits: 1, Enabled: true})
	bucket.GrantPoints(st.DB, "u1", 100, nil, "test")

	cost, err := s.Charge("op1", "u1", "websearch", 1)
	if err != nil || cost != 10 {
		t.Fatalf("charge want 10 got %d err %v", cost, err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 90 {
		t.Fatalf("after charge want 90 got %d", b)
	}
	// 幂等
	cost2, _ := s.Charge("op1", "u1", "websearch", 1)
	if cost2 != 10 {
		t.Fatalf("idempotent want 10 got %d", cost2)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 90 {
		t.Fatalf("idempotent must not double-charge, got %d", b)
	}
	// 退
	if err := s.RefundCharge("op1"); err != nil {
		t.Fatalf("refund: %v", err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 100 {
		t.Fatalf("after refund want 100 got %d", b)
	}
	// 退款幂等
	if err := s.RefundCharge("op1"); err != nil {
		t.Fatalf("refund idempotent: %v", err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 100 {
		t.Fatalf("double refund must not double-credit, got %d", b)
	}
	cost3, err := s.Charge("op1", "u1", "websearch", 1)
	if err != nil || cost3 != 10 {
		t.Fatalf("recharge refunded op want 10 got %d err %v", cost3, err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 90 {
		t.Fatalf("recharge refunded op should consume again, got %d", b)
	}
}

func TestChargeInsufficient(t *testing.T) {
	st := newStore(t)
	s := New(st)
	st.DB.Create(&model.ResourcePrice{ResourceKey: "video", PricingType: "PER_CALL", Rate: 800, PerUnits: 1, Enabled: true})
	bucket.GrantPoints(st.DB, "u1", 100, nil, "test")
	_, err := s.Charge("op2", "u1", "video", 1)
	if err != ErrInsufficient {
		t.Fatalf("want ErrInsufficient got %v", err)
	}
	var n int64
	st.DB.Model(&model.UsageRecord{}).Where("operation_id=?", "op2").Count(&n)
	if n != 0 {
		t.Fatalf("insufficient must not write record, got %d", n)
	}
}

func TestReserveSettleAndRefundResourceUsage(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if err := st.DB.Create(&model.ResourcePrice{ResourceKey: "novel_text_output", PricingType: "PER_UNIT", Rate: 2, PerUnits: 1000, Enabled: true}).Error; err != nil {
		t.Fatalf("create novel price: %v", err)
	}
	if err := bucket.GrantPoints(st.DB, "u1", 100, nil, "test"); err != nil {
		t.Fatalf("grant points: %v", err)
	}

	reserved, err := s.Reserve("novel:op1", "u1", "novel_text_output", 2000)
	if err != nil || reserved != 4 {
		t.Fatalf("reserve want 4 got %d err %v", reserved, err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 96 {
		t.Fatalf("after reserve want 96 got %d", b)
	}

	settled, err := s.Settle("novel:op1", "novel_text_output", 1250)
	if err != nil || settled != 3 {
		t.Fatalf("settle want 3 got %d err %v", settled, err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 97 {
		t.Fatalf("after settle want 97 got %d", b)
	}
	settledAgain, err := s.Settle("novel:op1", "novel_text_output", 1250)
	if err != nil || settledAgain != 3 {
		t.Fatalf("settle idempotent want 3 got %d err %v", settledAgain, err)
	}

	if err := s.RefundCharge("novel:op1"); err != nil {
		t.Fatalf("refund settled resource: %v", err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 100 {
		t.Fatalf("after refund want 100 got %d", b)
	}
	if err := s.RefundCharge("novel:op1"); err != nil {
		t.Fatalf("refund idempotent: %v", err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 100 {
		t.Fatalf("double refund must not double-credit, got %d", b)
	}
}

func TestRefundReservedResourceUsage(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if err := st.DB.Create(&model.ResourcePrice{ResourceKey: "novel_text_output", PricingType: "PER_UNIT", Rate: 2, PerUnits: 1000, Enabled: true}).Error; err != nil {
		t.Fatalf("create novel price: %v", err)
	}
	if err := bucket.GrantPoints(st.DB, "u1", 100, nil, "test"); err != nil {
		t.Fatalf("grant points: %v", err)
	}

	if _, err := s.Reserve("novel:op2", "u1", "novel_text_output", 1000); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if err := s.RefundCharge("novel:op2"); err != nil {
		t.Fatalf("refund reserved resource: %v", err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 100 {
		t.Fatalf("reserved refund should restore balance, got %d", b)
	}
	var row model.UsageRecord
	if err := st.DB.First(&row, "operation_id = ?", "novel:op2").Error; err != nil {
		t.Fatalf("find usage: %v", err)
	}
	if row.Status != "refunded" || row.ActualPoints != 0 {
		t.Fatalf("reserved refund should mark refunded with zero actual points, got %+v", row)
	}
}

func TestSettleResourceUsageCanChargeAboveReserve(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if err := st.DB.Create(&model.ResourcePrice{ResourceKey: "novel_text_output", PricingType: "PER_UNIT", Rate: 10, PerUnits: 1000, Enabled: true}).Error; err != nil {
		t.Fatalf("create novel price: %v", err)
	}
	// 预留 1000 单位 = ceil(10*1000/1000)=10 点；结算 2000 单位 = 20 点（超预留 10）。
	// 需发放 20 点：预留占 10、补扣从剩余 10 点全额扣满 → settled=20 且余额归 0。
	if err := bucket.GrantPoints(st.DB, "u1", 20, nil, "test"); err != nil {
		t.Fatalf("grant points: %v", err)
	}

	if _, err := s.Reserve("novel:op3", "u1", "novel_text_output", 1000); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	settled, err := s.Settle("novel:op3", "novel_text_output", 2000)
	if err != nil || settled != 20 {
		t.Fatalf("settle want 20 got %d err %v", settled, err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 0 {
		t.Fatalf("extra charge should drain remaining balance, got %d", b)
	}
}

func TestEnsureDefaultResourcePricesSeedsNovelResources(t *testing.T) {
	st := newStore(t)
	s := New(st)

	if err := s.EnsureDefaultResourcePrices(); err != nil {
		t.Fatalf("ensure defaults: %v", err)
	}
	var novel model.ResourcePrice
	if err := st.DB.First(&novel, "resource_key = ?", "novel_text_output").Error; err != nil {
		t.Fatalf("find novel default price: %v", err)
	}
	if novel.DisplayName != "小说文字生成" || novel.PricingType != "PER_UNIT" || novel.Rate != 1 || novel.PerUnits != 1000 || !novel.Enabled {
		t.Fatalf("unexpected novel default price: %+v", novel)
	}
	var article model.ResourcePrice
	if err := st.DB.First(&article, "resource_key = ?", "article_workflow_text_output").Error; err != nil {
		t.Fatalf("find article workflow default price: %v", err)
	}
	if article.DisplayName != "公众号图文生成" || article.PricingType != "PER_UNIT" || article.Rate != 1 || article.PerUnits != 1000 || !article.Enabled {
		t.Fatalf("unexpected article workflow default price: %+v", article)
	}
	var cover model.ResourcePrice
	if err := st.DB.First(&cover, "resource_key = ?", "novel_cover_generation").Error; err != nil {
		t.Fatalf("find novel cover default price: %v", err)
	}
	if cover.DisplayName != "小说封面生成" || cover.PricingType != "PER_CALL" || cover.Rate != 10 || cover.PerUnits != 1 || !cover.Enabled {
		t.Fatalf("unexpected novel cover default price: %+v", cover)
	}
	for _, tc := range []struct {
		key         string
		displayName string
		pricingType string
		rate        float64
	}{
		{"image_generation_1k", "图片生成 1K", "PER_UNIT", 10},
		{"image_generation_2k", "图片生成 2K", "PER_UNIT", 20},
		{"image_generation_4k", "图片生成 4K", "PER_UNIT", 40},
		{"ecom_master_generation_1k", "电商长图母版 1K", "PER_UNIT", 10},
		{"ecom_master_generation_2k", "电商长图母版 2K", "PER_UNIT", 20},
		{"ecom_master_generation_4k", "电商长图母版 4K", "PER_UNIT", 40},
		{"ecom_segment_generation_1k", "电商长图分段 1K", "PER_UNIT", 10},
		{"ecom_segment_generation_2k", "电商长图分段 2K", "PER_UNIT", 20},
		{"ecom_segment_generation_4k", "电商长图分段 4K", "PER_UNIT", 40},
		{"local_business_promo_render_25s", "本地商家宣传成片生成 25 秒", "PER_CALL", 25},
		{"local_business_promo_render_40s", "本地商家宣传成片生成 40 秒", "PER_CALL", 40},
		{"local_business_promo_render_60s", "本地商家宣传成片生成 60 秒", "PER_CALL", 60},
	} {
		var row model.ResourcePrice
		if err := st.DB.First(&row, "resource_key = ?", tc.key).Error; err != nil {
			t.Fatalf("find default price %s: %v", tc.key, err)
		}
		if row.DisplayName != tc.displayName || row.PricingType != tc.pricingType || row.Rate != tc.rate || row.PerUnits != 1 || !row.Enabled {
			t.Fatalf("unexpected default price %s: %+v", tc.key, row)
		}
	}
	for _, tc := range []struct {
		key         string
		displayName string
		pricingType string // 无输入视频 PER_UNIT；有输入视频复合计价 VIDEO_IO
	}{
		{"video_seedance_2_4k_text", "Seedance-2.0 4k 无输入视频", "PER_UNIT"},
		{"video_seedance_2_1080p_with_video", "Seedance-2.0 1080p 有输入视频", "VIDEO_IO"},
		{"video_seedance_2_fast_720p_text", "Seedance-2.0 Fast 720p 无输入视频", "PER_UNIT"},
		{"video_seedance_2_mini_480p_with_video", "Seedance-2.0 Mini 480p 有输入视频", "VIDEO_IO"},
	} {
		var row model.ResourcePrice
		if err := st.DB.First(&row, "resource_key = ?", tc.key).Error; err != nil {
			t.Fatalf("find video default price %s: %v", tc.key, err)
		}
		if row.DisplayName != tc.displayName || row.PricingType != tc.pricingType || row.Rate != 0 || row.OutputRate != 0 || row.PerUnits != 1 || row.Enabled {
			t.Fatalf("unexpected video default price %s: %+v", tc.key, row)
		}
	}
}

func TestRechargeRatio(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if r := s.RechargeRatio(); r != 100 { // 默认
		t.Fatalf("default want 100 got %d", r)
	}
	if err := s.SetRechargeRatio(200); err != nil {
		t.Fatal(err)
	}
	if r := s.RechargeRatio(); r != 200 {
		t.Fatalf("after set want 200 got %d", r)
	}
	// ¥10 = 1000 分；ratio 200 点/元 → 10*200=2000 点
	if p := s.PointsForAmount(1000); p != 2000 {
		t.Fatalf("points want 2000 got %d", p)
	}
}

func TestRechargePackages(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if pkgs := s.EnabledRechargePackages(); len(pkgs) == 0 {
		t.Fatalf("default packages should not be empty")
	}
	custom := []RechargePackage{
		{ID: "b", Name: "B", AmountFen: 2000, Points: 2200, Enabled: false, SortOrder: 20},
		{ID: "a", Name: "A", AmountFen: 1000, Points: 1200, Enabled: true, SortOrder: 10},
	}
	if err := s.SetRechargePackages(custom); err != nil {
		t.Fatal(err)
	}
	all := s.RechargePackages()
	if len(all) != 2 || all[0].ID != "a" {
		t.Fatalf("packages should be sorted by sortOrder, got %+v", all)
	}
	enabled := s.EnabledRechargePackages()
	if len(enabled) != 1 || enabled[0].ID != "a" {
		t.Fatalf("enabled packages want only a, got %+v", enabled)
	}
	pkg, ok := s.FindEnabledRechargePackage("a")
	if !ok || pkg.Points != 1200 {
		t.Fatalf("find enabled package failed: %+v %v", pkg, ok)
	}
	if _, ok := s.FindEnabledRechargePackage("b"); ok {
		t.Fatalf("disabled package must not be used for topup")
	}
}

func TestSetRechargePackagesRejectsDuplicateID(t *testing.T) {
	st := newStore(t)
	s := New(st)
	err := s.SetRechargePackages([]RechargePackage{
		{ID: "dup", Name: "A", AmountFen: 100, Points: 100, Enabled: true},
		{ID: "dup", Name: "B", AmountFen: 200, Points: 200, Enabled: true},
	})
	if err == nil {
		t.Fatal("duplicate package id should fail")
	}
}

func TestSetRechargePackagesRejectsMoreThanTen(t *testing.T) {
	st := newStore(t)
	s := New(st)
	pkgs := make([]RechargePackage, 0, 11)
	for i := 0; i < 11; i++ {
		pkgs = append(pkgs, RechargePackage{
			ID:        "pkg_" + strconv.Itoa(i+1),
			Name:      "套餐",
			AmountFen: int64(i+1) * 100,
			Points:    int64(i+1) * 100,
			Enabled:   true,
			SortOrder: i + 1,
		})
	}
	err := s.SetRechargePackages(pkgs)
	if err == nil {
		t.Fatal("more than 10 packages should fail")
	}
}

// 视频扣费只动视频点、不动算力点，退款按视频点原路退回（双账户 × VIP 合并后仍成立）。
func TestChargeVideoUsesVideoBalanceOnly(t *testing.T) {
	st := newStore(t)
	s := New(st)
	if err := st.DB.Create(&model.ResourcePrice{ResourceKey: "video_seedance_2_720p_text", PricingType: "PER_UNIT", Rate: 3, PerUnits: 1, Enabled: true}).Error; err != nil {
		t.Fatalf("create video price: %v", err)
	}
	if err := bucket.GrantPoints(st.DB, "u1", 1000, nil, "test"); err != nil {
		t.Fatalf("grant compute points: %v", err)
	}
	if _, err := s.ChargeVideo("video:op1", "u1", "video_seedance_2_720p_text", 8); err != ErrInsufficient {
		t.Fatalf("视频扣费应只检查视频点余额, got %v", err)
	}

	if err := st.DB.Transaction(func(tx *gorm.DB) error {
		return videopoint.CreditInTx(tx, "u1", 30)
	}); err != nil {
		t.Fatalf("grant video points: %v", err)
	}
	cost, err := s.ChargeVideo("video:op1", "u1", "video_seedance_2_720p_text", 8)
	if err != nil || cost != 24 {
		t.Fatalf("video charge want 24 got %d err %v", cost, err)
	}
	if b, _ := bucket.Balance(st.DB, "u1"); b != 1000 {
		t.Fatalf("视频扣费不应消耗算力点, got %d", b)
	}
	if b, _ := videopoint.Balance(st.DB, "u1"); b != 6 {
		t.Fatalf("视频点余额应剩余 6, got %d", b)
	}
	if err := s.RefundCharge("video:op1"); err != nil {
		t.Fatalf("refund video charge: %v", err)
	}
	if b, _ := videopoint.Balance(st.DB, "u1"); b != 30 {
		t.Fatalf("视频扣费退款应退回视频点, got %d", b)
	}
}
