package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"yc-billing/internal/billingmode"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/pgtest"
	"yc-billing/internal/store"
	"yc-billing/internal/videopoint"
	"yc-billing/internal/vip"
)

func learningRouter(st *store.Store) *gin.Engine {
	r := gin.New()
	NewWithPricingMode(st, "test-token", nil, billingmode.Learning).Register(r)
	return r
}

func postJSON(r http.Handler, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", "test-token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestLearningTokenReserveSettleCostsOneAndKeepsUsage(t *testing.T) {
	st := newAPIStore(t)
	st.DB.Create(&model.PriceRule{
		Model: "expensive-model", DisplayName: "Expensive", Enabled: true,
		InputPricePerMillion: 100000, OutputPricePerMillion: 200000,
	})
	if err := bucket.GrantPoints(st.DB, "learn-chat", 2, nil, bucket.SourceSystem); err != nil {
		t.Fatal(err)
	}
	r := learningRouter(st)

	reserveBody := `{"operationId":"learn:chat:1","userId":"learn-chat","type":"chat","model":"expensive-model","inputTokens":50000,"maxOutputTokens":50000}`
	for range 2 {
		w := postJSON(r, "/reserve", reserveBody)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"reserved":1`) {
			t.Fatalf("reserve status=%d body=%s", w.Code, w.Body.String())
		}
	}
	w := postJSON(r, "/settle", `{"operationId":"learn:chat:1","userId":"learn-chat","model":"expensive-model","inputTokens":40000,"outputTokens":30000,"cacheInputTokens":2000,"cacheOutputTokens":1000}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"settled":1`) {
		t.Fatalf("settle status=%d body=%s", w.Code, w.Body.String())
	}
	if got, _ := bucket.Balance(st.DB, "learn-chat"); got != 1 {
		t.Fatalf("balance=%d, want 1", got)
	}
	var usage model.UsageRecord
	if err := st.DB.First(&usage, "operation_id = ?", "learn:chat:1").Error; err != nil {
		t.Fatal(err)
	}
	if usage.ActualPoints != 1 || usage.InputTokens != 40000 || usage.OutputTokens != 30000 || usage.CacheInputTokens != 2000 || usage.CacheOutputTokens != 1000 {
		t.Fatalf("unexpected usage: %+v", usage)
	}
}

func TestLearningChargePointsAndVideoUseTheirOwnAccounts(t *testing.T) {
	st := newAPIStore(t)
	st.DB.Create(&model.ResourcePrice{ResourceKey: "video_api", PricingType: "VIDEO_IO", Rate: 5, OutputRate: 10, PerUnits: 1, Enabled: true})
	if err := bucket.GrantPoints(st.DB, "learn-api", 3, nil, bucket.SourceSystem); err != nil {
		t.Fatal(err)
	}
	if err := videopoint.CreditInTx(st.DB, "learn-api", 2); err != nil {
		t.Fatal(err)
	}
	r := learningRouter(st)

	w := postJSON(r, "/charge-points", `{"operationId":"learn:kb:1","userId":"learn-api","points":900,"kind":"kb_quota"}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"charged":1`) {
		t.Fatalf("charge-points status=%d body=%s", w.Code, w.Body.String())
	}
	w = postJSON(r, "/resource/charge", `{"operationId":"learn:video:api","userId":"learn-api","resourceKey":"video_api","units":60,"inputUnits":30,"accountType":"video"}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"charged":1`) {
		t.Fatalf("video charge status=%d body=%s", w.Code, w.Body.String())
	}
	w = postJSON(r, "/resource/settle-video", `{"operationId":"learn:video:api","resourceKey":"video_api","units":45,"inputUnits":30}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"settled":1`) {
		t.Fatalf("video settle status=%d body=%s", w.Code, w.Body.String())
	}
	if got, _ := bucket.Balance(st.DB, "learn-api"); got != 2 {
		t.Fatalf("points balance=%d, want 2 after only charge-points used it", got)
	}
	if got, _ := videopoint.Balance(st.DB, "learn-api"); got != 1 {
		t.Fatalf("video balance=%d, want 1", got)
	}
	w = postJSON(r, "/resource/refund", `{"operationId":"learn:video:api"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("refund status=%d body=%s", w.Code, w.Body.String())
	}
	if got, _ := videopoint.Balance(st.DB, "learn-api"); got != 2 {
		t.Fatalf("refunded video points=%d, want 2", got)
	}
}

func TestLearningReturns402AtZeroBalance(t *testing.T) {
	st := newAPIStore(t)
	st.DB.Create(&model.ResourcePrice{ResourceKey: "image_api", PricingType: "PER_CALL", Rate: 40, PerUnits: 1, Enabled: true})
	st.DB.Create(&model.ResourcePrice{ResourceKey: "video_empty_api", PricingType: "PER_UNIT", Rate: 40, PerUnits: 1, Enabled: true})
	r := learningRouter(st)
	w := postJSON(r, "/resource/charge", `{"operationId":"learn:empty:1","userId":"learn-empty","resourceKey":"image_api","units":1}`)
	if w.Code != http.StatusPaymentRequired || !strings.Contains(w.Body.String(), `"code":"INSUFFICIENT_BALANCE"`) {
		t.Fatalf("points status=%d body=%s", w.Code, w.Body.String())
	}
	w = postJSON(r, "/resource/charge", `{"operationId":"learn:video-empty:1","userId":"learn-empty","resourceKey":"video_empty_api","units":1,"accountType":"video"}`)
	if w.Code != http.StatusPaymentRequired || !strings.Contains(w.Body.String(), `"code":"INSUFFICIENT_BALANCE"`) {
		t.Fatalf("video status=%d body=%s", w.Code, w.Body.String())
	}
}

func newAPIStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(pgtest.DSN())
	if err != nil {
		t.Skipf("billing-postgres 不可用: %v", err)
	}
	pgtest.Serialize(t, st.DB)
	if err := st.DB.Exec("TRUNCATE vip_growth_ledgers, user_vip_states, vip_levels, membership_cards, user_memberships, membership_grants, point_buckets, usage_records, price_rules, platform_configs CASCADE").Error; err != nil {
		t.Fatalf("truncate failed: %v", err)
	}
	if err := vip.New(st.DB).EnsureDefaultLevels(100); err != nil {
		t.Fatalf("EnsureDefaultLevels failed: %v", err)
	}
	return st
}

func TestMembershipUserEndpointsReturnDataEnvelope(t *testing.T) {
	st := newAPIStore(t)
	card := model.MembershipCard{
		Name: "Smoke Card", PriceFen: 100, DurationDays: 1,
		Cadence: "DAILY", GrantPoints: 7, Enabled: true,
	}
	if err := st.DB.Create(&card).Error; err != nil {
		t.Fatalf("create card: %v", err)
	}
	if err := st.DB.Create(&model.UserMembership{
		UserID: "u1", CardID: card.ID, Cadence: "DAILY", GrantPoints: 7,
		StartAt: time.Now(), ExpiresAt: time.Now().AddDate(0, 0, 1),
		Status: "active", CreatedAt: time.Now(),
	}).Error; err != nil {
		t.Fatalf("create membership: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	New(st, "test-token", nil).Register(r)

	for _, tc := range []struct {
		name string
		path string
	}{
		{name: "cards", path: "/membership/cards"},
		{name: "mine", path: "/membership/mine/u1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.Header.Set("X-Internal-Token", "test-token")
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			var body map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("json: %v", err)
			}
			if _, ok := body["data"]; !ok {
				t.Fatalf("response must contain data envelope, got %s", w.Body.String())
			}
		})
	}
}

func TestUsageEndpointReturnsSettledRecordsForUser(t *testing.T) {
	st := newAPIStore(t)
	now := time.Now()
	older := now.Add(-time.Hour)
	if err := st.DB.Create(&model.UsageRecord{
		OperationID: "op-old", UserID: "u1", Type: "chat", Model: "m1",
		Status: "settled", ReservedPoints: 9, ActualPoints: 2, CreatedAt: older, SettledAt: &older,
	}).Error; err != nil {
		t.Fatalf("create older usage: %v", err)
	}
	if err := st.DB.Create(&model.UsageRecord{
		OperationID: "op-new", UserID: "u1", Type: "chat", Model: "m2",
		Status: "settled", ReservedPoints: 9, ActualPoints: 1, CreatedAt: now, SettledAt: &now,
	}).Error; err != nil {
		t.Fatalf("create newer usage: %v", err)
	}
	if err := st.DB.Create(&model.UsageRecord{
		OperationID: "op-other", UserID: "u2", Type: "chat", Model: "m3",
		Status: "settled", ReservedPoints: 9, ActualPoints: 5, CreatedAt: now, SettledAt: &now,
	}).Error; err != nil {
		t.Fatalf("create other usage: %v", err)
	}
	if err := st.DB.Create(&model.PriceRule{
		Model: "m2", DisplayName: "Model Two", Enabled: true,
	}).Error; err != nil {
		t.Fatalf("create price rule: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	New(st, "test-token", nil).Register(r)

	req := httptest.NewRequest(http.MethodGet, "/usage/u1?limit=2", nil)
	req.Header.Set("X-Internal-Token", "test-token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var body struct {
		Data []struct {
			OperationID    string `json:"operationId"`
			Model          string `json:"model"`
			DisplayName    string `json:"displayName"`
			ActualPoints   int64  `json:"actualPoints"`
			ReservedPoints int64  `json:"reservedPoints"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("json: %v", err)
	}
	if len(body.Data) != 2 {
		t.Fatalf("want 2 rows, got %+v", body.Data)
	}
	if body.Data[0].OperationID != "op-new" || body.Data[0].ActualPoints != 1 {
		t.Fatalf("newest row first with actual points, got %+v", body.Data[0])
	}
	if body.Data[0].DisplayName != "Model Two" {
		t.Fatalf("newest row should include display name, got %+v", body.Data[0])
	}
	if body.Data[1].OperationID != "op-old" {
		t.Fatalf("second row should be older user's row, got %+v", body.Data[1])
	}
}

func TestSettlePersistsTokenBreakdownInUsageRecord(t *testing.T) {
	st := newAPIStore(t)
	now := time.Now()
	if err := st.DB.Create(&model.PriceRule{
		Model: "m-token", DisplayName: "Token Model", Enabled: true,
		ModelRatio: 0.001, CompletionRatio: 1,
		InputPricePerMillion: 1000, OutputPricePerMillion: 2000,
		CacheInputPricePerMillion: 100, CacheOutputPricePerMillion: 200,
	}).Error; err != nil {
		t.Fatalf("create price rule: %v", err)
	}
	if err := st.DB.Create(&model.PointBucket{
		UserID: "u-token", Remaining: 1000, Source: "test", CreatedAt: now,
	}).Error; err != nil {
		t.Fatalf("create bucket: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	New(st, "test-token", nil).Register(r)

	reserve := httptest.NewRequest(http.MethodPost, "/reserve", strings.NewReader(`{
		"operationId":"op-token",
		"userId":"u-token",
		"type":"chat",
		"model":"m-token",
		"inputTokens":1000,
		"maxOutputTokens":1000
	}`))
	reserve.Header.Set("Content-Type", "application/json")
	reserve.Header.Set("X-Internal-Token", "test-token")
	reserveResp := httptest.NewRecorder()
	r.ServeHTTP(reserveResp, reserve)
	if reserveResp.Code != http.StatusOK {
		t.Fatalf("reserve status=%d body=%s", reserveResp.Code, reserveResp.Body.String())
	}

	settle := httptest.NewRequest(http.MethodPost, "/settle", strings.NewReader(`{
		"operationId":"op-token",
		"userId":"u-token",
		"model":"m-token",
		"inputTokens":123,
		"outputTokens":45,
		"cacheInputTokens":6,
		"cacheOutputTokens":7
	}`))
	settle.Header.Set("Content-Type", "application/json")
	settle.Header.Set("X-Internal-Token", "test-token")
	settleResp := httptest.NewRecorder()
	r.ServeHTTP(settleResp, settle)
	if settleResp.Code != http.StatusOK {
		t.Fatalf("settle status=%d body=%s", settleResp.Code, settleResp.Body.String())
	}

	var row model.UsageRecord
	if err := st.DB.First(&row, "operation_id = ?", "op-token").Error; err != nil {
		t.Fatalf("find usage: %v", err)
	}
	if row.InputTokens != 123 || row.OutputTokens != 45 ||
		row.CacheInputTokens != 6 || row.CacheOutputTokens != 7 {
		t.Fatalf("settle must persist token breakdown, got %+v", row)
	}
}

func TestResourceReserveAndSettleEndpoints(t *testing.T) {
	st := newAPIStore(t)
	st.DB.Exec("TRUNCATE resource_prices, point_buckets, usage_records CASCADE")
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "novel_text_output", DisplayName: "小说文字生成", PricingType: "PER_UNIT",
		Rate: 2, PerUnits: 1000, Enabled: true,
	}).Error; err != nil {
		t.Fatalf("create novel price: %v", err)
	}
	if err := bucket.GrantPoints(st.DB, "u-novel", 100, nil, "test"); err != nil {
		t.Fatalf("grant points: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	New(st, "test-token", nil).Register(r)

	reserve := httptest.NewRequest(http.MethodPost, "/resource/reserve", strings.NewReader(`{
		"operationId":"novel:task1",
		"userId":"u-novel",
		"resourceKey":"novel_text_output",
		"units":2000
	}`))
	reserve.Header.Set("Content-Type", "application/json")
	reserve.Header.Set("X-Internal-Token", "test-token")
	reserveResp := httptest.NewRecorder()
	r.ServeHTTP(reserveResp, reserve)
	if reserveResp.Code != http.StatusOK {
		t.Fatalf("reserve status=%d body=%s", reserveResp.Code, reserveResp.Body.String())
	}
	var reserveBody struct {
		Reserved int64 `json:"reserved"`
	}
	if err := json.Unmarshal(reserveResp.Body.Bytes(), &reserveBody); err != nil {
		t.Fatalf("reserve json: %v", err)
	}
	if reserveBody.Reserved != 4 {
		t.Fatalf("reserve want 4 got %+v", reserveBody)
	}

	settle := httptest.NewRequest(http.MethodPost, "/resource/settle", strings.NewReader(`{
		"operationId":"novel:task1",
		"resourceKey":"novel_text_output",
		"units":1250
	}`))
	settle.Header.Set("Content-Type", "application/json")
	settle.Header.Set("X-Internal-Token", "test-token")
	settleResp := httptest.NewRecorder()
	r.ServeHTTP(settleResp, settle)
	if settleResp.Code != http.StatusOK {
		t.Fatalf("settle status=%d body=%s", settleResp.Code, settleResp.Body.String())
	}
	var settleBody struct {
		Settled int64 `json:"settled"`
	}
	if err := json.Unmarshal(settleResp.Body.Bytes(), &settleBody); err != nil {
		t.Fatalf("settle json: %v", err)
	}
	if settleBody.Settled != 3 {
		t.Fatalf("settle want 3 got %+v", settleBody)
	}
}

func TestResourcePricesEndpointReturnsLowerCamelAndSkipsBlankKeys(t *testing.T) {
	st := newAPIStore(t)
	st.DB.Exec("TRUNCATE resource_prices CASCADE")
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "image_generation", DisplayName: "图片生成", PricingType: "PER_UNIT",
		Rate: 10, PerUnits: 1, Enabled: true,
	}).Error; err != nil {
		t.Fatalf("create image price: %v", err)
	}
	if err := st.DB.Create(&model.ResourcePrice{
		ResourceKey: "", DisplayName: "", PricingType: "PER_UNIT",
		Rate: 0, PerUnits: 1, Enabled: false,
	}).Error; err != nil {
		t.Fatalf("create blank price: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	New(st, "test-token", nil).Register(r)

	req := httptest.NewRequest(http.MethodGet, "/internal/admin/resource-prices", nil)
	req.Header.Set("X-Internal-Token", "test-token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if json.Valid(w.Body.Bytes()) && (containsJSONField(w.Body.String(), "ResourceKey") || containsJSONField(w.Body.String(), "PricingType")) {
		t.Fatalf("resource price JSON must use lowerCamel fields, got %s", w.Body.String())
	}
	type resourcePriceResponseRow struct {
		ResourceKey string  `json:"resourceKey"`
		DisplayName string  `json:"displayName"`
		PricingType string  `json:"pricingType"`
		Rate        float64 `json:"rate"`
		PerUnits    int64   `json:"perUnits"`
		Enabled     bool    `json:"enabled"`
	}
	var body struct {
		Data []resourcePriceResponseRow `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("json: %v", err)
	}
	if len(body.Data) < 10 {
		t.Fatalf("default resource prices should be visible and blank keys hidden, got %+v", body.Data)
	}
	byKey := map[string]resourcePriceResponseRow{}
	for _, row := range body.Data {
		if row.ResourceKey == "" {
			t.Fatalf("blank resource keys should be hidden, got %+v", body.Data)
		}
		byKey[row.ResourceKey] = row
	}
	if row := byKey["image_generation_1k"]; row.PricingType != "PER_UNIT" || row.Rate != 10 || !row.Enabled {
		t.Fatalf("image 1K default should be visible, got %+v", row)
	}
	if row := byKey["image_generation_4k"]; row.PricingType != "PER_UNIT" || row.Rate != 40 || !row.Enabled {
		t.Fatalf("image 4K default should be visible, got %+v", row)
	}
	if row := byKey["ecom_master_generation_4k"]; row.PricingType != "PER_UNIT" || row.Rate != 40 || !row.Enabled {
		t.Fatalf("ecom master 4K default should be visible, got %+v", row)
	}
	if row := byKey["novel_cover_generation"]; row.PricingType != "PER_CALL" || !row.Enabled {
		t.Fatalf("novel cover resource default should be visible, got %+v", row)
	}
	if row := byKey["novel_text_output"]; row.PerUnits != 1000 || !row.Enabled {
		t.Fatalf("novel resource default should be visible, got %+v", row)
	}
}

func TestAdminModelIdentityDeleteAndStatsEndpoints(t *testing.T) {
	st := newAPIStore(t)
	now := time.Now()
	if err := st.DB.Create(&model.PriceRule{
		Model: "old-model", DisplayName: "旧模型", Enabled: true,
		InputPricePerMillion: 100, OutputPricePerMillion: 200,
	}).Error; err != nil {
		t.Fatalf("create price rule: %v", err)
	}
	if err := st.DB.Create(&model.UsageRecord{
		OperationID: "usage-1", UserID: "u1", Type: "chat", Model: "old-model",
		Status: "settled", ReservedPoints: 20, ActualPoints: 12,
		InputTokens: 100, OutputTokens: 40, CreatedAt: now, SettledAt: &now,
	}).Error; err != nil {
		t.Fatalf("create usage 1: %v", err)
	}
	if err := st.DB.Create(&model.UsageRecord{
		OperationID: "usage-2", UserID: "u2", Type: "embedding", Model: "old-model",
		Status: "settled", ReservedPoints: 20, ActualPoints: 7,
		InputTokens: 50, CreatedAt: now, SettledAt: &now,
	}).Error; err != nil {
		t.Fatalf("create usage 2: %v", err)
	}
	if err := st.DB.Create(&model.UsageRecord{
		OperationID: "usage-reserved", UserID: "u2", Type: "chat", Model: "old-model",
		Status: "reserved", ReservedPoints: 20, ActualPoints: 99,
		CreatedAt: now,
	}).Error; err != nil {
		t.Fatalf("create reserved usage: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	New(st, "test-token", nil).Register(r)

	rename := httptest.NewRequest(http.MethodPatch, "/internal/admin/models/identity", strings.NewReader(`{
		"model":"old-model",
		"newModel":"new-model",
		"displayName":"新模型",
		"enabled":false
	}`))
	rename.Header.Set("Content-Type", "application/json")
	rename.Header.Set("X-Internal-Token", "test-token")
	renameResp := httptest.NewRecorder()
	r.ServeHTTP(renameResp, rename)
	if renameResp.Code != http.StatusOK {
		t.Fatalf("rename status=%d body=%s", renameResp.Code, renameResp.Body.String())
	}
	var renamed model.PriceRule
	if err := st.DB.First(&renamed, "model = ?", "new-model").Error; err != nil {
		t.Fatalf("find renamed model: %v", err)
	}
	if renamed.DisplayName != "新模型" || renamed.Enabled {
		t.Fatalf("identity update should persist display/enabled, got %+v", renamed)
	}
	var migratedUsage int64
	if err := st.DB.Model(&model.UsageRecord{}).Where("model = ?", "new-model").Count(&migratedUsage).Error; err != nil {
		t.Fatalf("count migrated usage: %v", err)
	}
	if migratedUsage != 3 {
		t.Fatalf("identity update should migrate usage records, count=%d", migratedUsage)
	}

	statsReq := httptest.NewRequest(http.MethodGet, "/internal/admin/models/stats?model=new-model", nil)
	statsReq.Header.Set("X-Internal-Token", "test-token")
	statsResp := httptest.NewRecorder()
	r.ServeHTTP(statsResp, statsReq)
	if statsResp.Code != http.StatusOK {
		t.Fatalf("stats status=%d body=%s", statsResp.Code, statsResp.Body.String())
	}
	var statsBody struct {
		Data struct {
			Model        string `json:"model"`
			DisplayName  string `json:"displayName"`
			TotalPoints  int64  `json:"totalPoints"`
			UsageCount   int64  `json:"usageCount"`
			UserCount    int64  `json:"userCount"`
			InputTokens  int64  `json:"inputTokens"`
			OutputTokens int64  `json:"outputTokens"`
		} `json:"data"`
	}
	if err := json.Unmarshal(statsResp.Body.Bytes(), &statsBody); err != nil {
		t.Fatalf("stats json: %v", err)
	}
	if statsBody.Data.TotalPoints != 19 || statsBody.Data.UsageCount != 2 || statsBody.Data.UserCount != 2 {
		t.Fatalf("stats must sum settled usage only, got %+v", statsBody.Data)
	}
	if statsBody.Data.DisplayName != "新模型" || statsBody.Data.InputTokens != 150 || statsBody.Data.OutputTokens != 40 {
		t.Fatalf("stats detail mismatch: %+v", statsBody.Data)
	}

	del := httptest.NewRequest(http.MethodPost, "/internal/admin/models/delete", strings.NewReader(`{"model":"new-model"}`))
	del.Header.Set("Content-Type", "application/json")
	del.Header.Set("X-Internal-Token", "test-token")
	delResp := httptest.NewRecorder()
	r.ServeHTTP(delResp, del)
	if delResp.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", delResp.Code, delResp.Body.String())
	}
	var count int64
	if err := st.DB.Model(&model.PriceRule{}).Where("model = ?", "new-model").Count(&count).Error; err != nil {
		t.Fatalf("count model: %v", err)
	}
	if count != 0 {
		t.Fatalf("model config should be deleted, count=%d", count)
	}
}

func containsJSONField(body string, field string) bool {
	return strings.Contains(body, `"`+field+`"`)
}
