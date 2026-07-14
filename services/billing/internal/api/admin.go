package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"ai-assistant-billing/internal/adjust"
	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/redeem"
	"ai-assistant-billing/internal/registry"
	"ai-assistant-billing/internal/resource"
)

func (h *Handler) RegisterAdmin(r *gin.Engine) {
	g := r.Group("/internal/admin", h.auth())
	g.POST("/codes", h.genCodes)
	g.GET("/codes", h.listCodes)
	g.POST("/codes/disable", h.disableCode)
	g.POST("/balance-adjust", h.balanceAdjust)
	g.POST("/balances", h.batchBalances)
	g.GET("/orders", h.listOrders)
	g.GET("/models", h.listModels)
	g.POST("/models", h.upsertModel)
	g.PATCH("/models/pricing", h.updateModelPricing)
	g.PATCH("/models/display", h.updateModelDisplay)
	g.PATCH("/models/identity", h.updateModelIdentity)
	g.POST("/models/delete", h.deleteModel)
	g.GET("/models/stats", h.modelStats)
	g.GET("/analytics/daily", h.analyticsDaily)
	g.POST("/analytics/revenue-by-users", h.analyticsRevenueByUsers)
	g.POST("/analytics/summary-by-users", h.analyticsSummaryByUsers)
	g.GET("/analytics/rankings", h.analyticsRankings)
	g.GET("/analytics/sales", h.analyticsSales)
	g.GET("/analytics/balances", h.analyticsBalances)
	g.GET("/analytics/user-summary", h.analyticsUserSummary)
	g.GET("/resource-prices", h.listResourcePrices)
	g.POST("/resource-prices", h.upsertResourcePrice)
	g.POST("/resource-prices/delete", h.deleteResourcePrice)
	g.GET("/config/recharge-ratio", h.getRechargeRatio)
	g.PUT("/config/recharge-ratio", h.setRechargeRatio)
	g.GET("/config/recharge-packages", h.getRechargePackages)
	g.PUT("/config/recharge-packages", h.setRechargePackages)
	g.GET("/config/kb-default-quota", h.getKbDefaultQuota)
	g.PUT("/config/kb-default-quota", h.setKbDefaultQuota)
	g.GET("/membership-cards", h.adminListMembershipCards)
	g.POST("/membership-cards", h.adminUpsertMembershipCard)
	g.POST("/membership-cards/delete", h.adminDeleteMembershipCard)
	g.GET("/vip-levels", h.adminListVipLevels)
	g.POST("/vip-levels", h.adminUpsertVipLevel)
	g.POST("/vip-levels/delete", h.adminDeleteVipLevel)
	// 启用模型列表（供 api 暴露 /api/models）
	r.GET("/internal/models", h.auth(), h.listEnabledModels)
}

type genCodesReq struct {
	GrantType    string `json:"grantType" binding:"required"`
	GrantPayload string `json:"grantPayload"`
	Points       int64  `json:"points"`
	Count        int    `json:"count" binding:"required"`
	ExpiresAt    *int64 `json:"expiresAt"` // unix 秒，可空
}

func (h *Handler) genCodes(c *gin.Context) {
	var req genCodesReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	var exp *time.Time
	if req.ExpiresAt != nil {
		t := time.Unix(*req.ExpiresAt, 0)
		exp = &t
	}
	codes, err := h.redeem.Generate(redeem.GenerateArgs{
		GrantType: req.GrantType, GrantPayload: req.GrantPayload,
		Points: req.Points, Count: req.Count, ExpiresAt: exp,
	})
	if err != nil {
		// 不回显内部错误细节（生产环境不暴露实现）；调用方为内部 api，参数已在 api 层 zod 校验
		c.JSON(http.StatusBadRequest, gin.H{"error": "生成兑换码失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"codes": codes})
}

func (h *Handler) listCodes(c *gin.Context) {
	rows, err := h.redeem.List(redeem.ListFilter{
		Status:    c.Query("status"),
		GrantType: c.Query("grantType"),
		BatchID:   c.Query("batchId"),
		Limit:     atoiDefault(c.Query("limit"), 100),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rows})
}

type disableCodeReq struct {
	Code string `json:"code" binding:"required"`
}

func (h *Handler) disableCode(c *gin.Context) {
	var req disableCodeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if err := h.redeem.Disable(req.Code); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "code not disableable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

type balanceAdjustReq struct {
	OperationID string `json:"operationId" binding:"required"`
	UserID      string `json:"userId" binding:"required"`
	Delta       int64  `json:"delta" binding:"required"`
	Reason      string `json:"reason"`
	AdminID     string `json:"adminId" binding:"required"`
	AccountType string `json:"accountType"` // points（默认）| video
}

func (h *Handler) balanceAdjust(c *gin.Context) {
	var req balanceAdjustReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	accountType := req.AccountType
	if accountType == "" {
		accountType = "points"
	}
	if accountType != "points" && accountType != "video" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid account type"})
		return
	}
	var before, after int64
	var err error
	if accountType == "video" {
		before, after, err = h.adjust.AdjustVideo(req.OperationID, req.UserID, req.Delta, req.Reason, req.AdminID)
	} else {
		before, after, err = h.adjust.Adjust(req.OperationID, req.UserID, req.Delta, req.Reason, req.AdminID)
	}
	if err == adjust.ErrInsufficient {
		c.JSON(http.StatusPaymentRequired, gin.H{"error": "insufficient", "code": "INSUFFICIENT_BALANCE"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "adjust failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"before": before, "after": after})
}

type batchBalancesReq struct {
	UserIDs []string `json:"userIds" binding:"required"`
}

func (h *Handler) batchBalances(c *gin.Context) {
	var req batchBalancesReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	balances, err := bucket.BatchBalances(h.st.DB, req.UserIDs)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "balances failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"balances": balances})
}

type adminOrderRow struct {
	ID            uint       `json:"id"`
	TradeNo       string     `json:"tradeNo"`
	UserID        string     `json:"userId"`
	AmountFen     int64      `json:"amountFen"`
	Points        int64      `json:"points"`
	Provider      string     `json:"provider"`
	PaymentMethod string     `json:"paymentMethod"`
	Status        string     `json:"status"`
	Kind          string     `json:"kind"`
	CardID        uint       `json:"cardId"`
	CreatedAt     time.Time  `json:"createdAt"`
	PaidAt        *time.Time `json:"paidAt"`
}

type adminOrderSummary struct {
	Total            int64 `json:"total"`
	SuccessCount     int64 `json:"successCount"`
	PendingCount     int64 `json:"pendingCount"`
	ClosedCount      int64 `json:"closedCount"`
	SuccessAmountFen int64 `json:"successAmountFen"`
	SuccessPoints    int64 `json:"successPoints"`
	PayingUsers      int64 `json:"payingUsers"`
}

func (h *Handler) listOrders(c *gin.Context) {
	limit := clampInt(atoiDefault(c.Query("limit"), 50), 1, 200)
	offset := clampInt(atoiDefault(c.Query("offset"), 0), 0, 100000)

	var total int64
	if err := h.adminOrdersQuery(c).Count(&total).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "count failed"})
		return
	}

	var summary adminOrderSummary
	if err := h.adminOrdersQuery(c).
		Select(`
			COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END),0) AS success_count,
			COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),0) AS pending_count,
			COALESCE(SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END),0) AS closed_count,
			COALESCE(SUM(CASE WHEN status = 'success' THEN amount_fen ELSE 0 END),0) AS success_amount_fen,
			COALESCE(SUM(CASE WHEN status = 'success' THEN points ELSE 0 END),0) AS success_points,
			COUNT(DISTINCT CASE WHEN status = 'success' THEN user_id ELSE NULL END) AS paying_users`).
		Scan(&summary).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "summary failed"})
		return
	}
	summary.Total = total

	var rows []model.TopUp
	if err := h.adminOrdersQuery(c).Order("created_at DESC, id DESC").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	out := make([]adminOrderRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, adminOrderRow{
			ID: row.ID, TradeNo: row.TradeNo, UserID: row.UserID, AmountFen: row.AmountFen, Points: row.Points,
			Provider: row.Provider, PaymentMethod: row.PaymentMethod, Status: row.Status, Kind: row.Kind,
			CardID: row.CardID, CreatedAt: row.CreatedAt, PaidAt: row.PaidAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": out, "total": total, "summary": summary})
}

func (h *Handler) adminOrdersQuery(c *gin.Context) *gorm.DB {
	q := h.st.DB.Model(&model.TopUp{})
	if status := strings.TrimSpace(c.Query("status")); status != "" {
		q = q.Where("status = ?", status)
	}
	if kind := strings.TrimSpace(c.Query("kind")); kind != "" {
		q = q.Where("kind = ?", kind)
	}
	if provider := strings.TrimSpace(c.Query("provider")); provider != "" {
		q = q.Where("provider = ?", provider)
	}
	if paymentMethod := strings.TrimSpace(c.Query("paymentMethod")); paymentMethod != "" {
		q = q.Where("payment_method = ?", paymentMethod)
	}
	if userID := strings.TrimSpace(c.Query("userId")); userID != "" {
		q = q.Where("user_id = ?", userID)
	}
	if userIDs := splitCSV(c.Query("userIds")); len(userIDs) > 0 {
		q = q.Where("user_id IN ?", userIDs)
	}
	if tradeNo := strings.TrimSpace(c.Query("tradeNo")); tradeNo != "" {
		q = q.Where("trade_no LIKE ?", "%"+tradeNo+"%")
	}
	if from, ok := parseAdminTime(c.Query("from"), false); ok {
		q = q.Where("created_at >= ?", from)
	}
	if to, ok := parseAdminTime(c.Query("to"), true); ok {
		q = q.Where("created_at < ?", to)
	}
	return q
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func parseAdminTime(raw string, endExclusive bool) (time.Time, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t, true
	}
	if t, err := time.ParseInLocation("2006-01-02", raw, time.Local); err == nil {
		if endExclusive {
			t = t.AddDate(0, 0, 1)
		}
		return t, true
	}
	return time.Time{}, false
}

func clampInt(n, min, max int) int {
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

func (h *Handler) listModels(c *gin.Context) {
	rows, err := h.registry.ListAll()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rows})
}

type upsertModelReq struct {
	Model       string `json:"model" binding:"required"`
	DisplayName string `json:"displayName"`
	Enabled     bool   `json:"enabled"`

	ModelRatio      *float64 `json:"modelRatio"`
	CompletionRatio *float64 `json:"completionRatio"`

	InputPricePerMillion       *float64 `json:"inputPricePerMillion"`
	OutputPricePerMillion      *float64 `json:"outputPricePerMillion"`
	CacheInputPricePerMillion  *float64 `json:"cacheInputPricePerMillion"`
	CacheOutputPricePerMillion *float64 `json:"cacheOutputPricePerMillion"`

	InputPriceRMBPerMillion       *float64 `json:"inputPriceRmbPerMillion"`
	OutputPriceRMBPerMillion      *float64 `json:"outputPriceRmbPerMillion"`
	CacheInputPriceRMBPerMillion  *float64 `json:"cacheInputPriceRmbPerMillion"`
	CacheOutputPriceRMBPerMillion *float64 `json:"cacheOutputPriceRmbPerMillion"`
	marketplaceMetaReq
}

func (h *Handler) upsertModel(c *gin.Context) {
	var req upsertModelReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if p, ok := rmbPricingFromAdminReq(req.InputPriceRMBPerMillion, req.OutputPriceRMBPerMillion, req.CacheInputPriceRMBPerMillion, req.CacheOutputPriceRMBPerMillion); ok {
		if err := h.registry.UpsertRMB(req.Model, req.DisplayName, p, req.Enabled); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "upsert failed"})
			return
		}
		if err := h.updateModelMarketplaceIfProvided(req.Model, req.marketplaceMetaReq); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "upsert failed"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"success": true})
		return
	}
	p, ok := pricingFromAdminReq(req.InputPricePerMillion, req.OutputPricePerMillion, req.CacheInputPricePerMillion, req.CacheOutputPricePerMillion, req.ModelRatio, req.CompletionRatio)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pricing"})
		return
	}
	if err := h.registry.Upsert(req.Model, req.DisplayName, p, req.Enabled); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upsert failed"})
		return
	}
	if err := h.updateModelMarketplaceIfProvided(req.Model, req.marketplaceMetaReq); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upsert failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

type updatePricingReq struct {
	Model string `json:"model" binding:"required"`

	ModelRatio      *float64 `json:"modelRatio"`
	CompletionRatio *float64 `json:"completionRatio"`

	InputPricePerMillion       *float64 `json:"inputPricePerMillion"`
	OutputPricePerMillion      *float64 `json:"outputPricePerMillion"`
	CacheInputPricePerMillion  *float64 `json:"cacheInputPricePerMillion"`
	CacheOutputPricePerMillion *float64 `json:"cacheOutputPricePerMillion"`

	InputPriceRMBPerMillion       *float64 `json:"inputPriceRmbPerMillion"`
	OutputPriceRMBPerMillion      *float64 `json:"outputPriceRmbPerMillion"`
	CacheInputPriceRMBPerMillion  *float64 `json:"cacheInputPriceRmbPerMillion"`
	CacheOutputPriceRMBPerMillion *float64 `json:"cacheOutputPriceRmbPerMillion"`
}

func (h *Handler) updateModelPricing(c *gin.Context) {
	var req updatePricingReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if p, ok := rmbPricingFromAdminReq(req.InputPriceRMBPerMillion, req.OutputPriceRMBPerMillion, req.CacheInputPriceRMBPerMillion, req.CacheOutputPriceRMBPerMillion); ok {
		if err := h.registry.UpdatePricingRMB(req.Model, p); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "model not found"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"success": true})
		return
	}
	p, ok := pricingFromAdminReq(req.InputPricePerMillion, req.OutputPricePerMillion, req.CacheInputPricePerMillion, req.CacheOutputPricePerMillion, req.ModelRatio, req.CompletionRatio)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pricing"})
		return
	}
	if err := h.registry.UpdatePricing(req.Model, p); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "model not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func rmbPricingFromAdminReq(input, output, cacheInput, cacheOutput *float64) (registry.RMBPricing, bool) {
	hasRMBPricing := input != nil || output != nil || cacheInput != nil || cacheOutput != nil
	if !hasRMBPricing {
		return registry.RMBPricing{}, false
	}
	if input == nil || output == nil || cacheInput == nil || cacheOutput == nil {
		return registry.RMBPricing{}, false
	}
	if *input < 0 || *output < 0 || *cacheInput < 0 || *cacheOutput < 0 {
		return registry.RMBPricing{}, false
	}
	return registry.RMBPricing{
		InputPriceRMBPerMillion:       *input,
		OutputPriceRMBPerMillion:      *output,
		CacheInputPriceRMBPerMillion:  *cacheInput,
		CacheOutputPriceRMBPerMillion: *cacheOutput,
	}, true
}

func pricingFromAdminReq(input, output, cacheInput, cacheOutput, modelRatio, completionRatio *float64) (registry.TokenPricing, bool) {
	hasTokenPricing := input != nil || output != nil || cacheInput != nil || cacheOutput != nil
	if hasTokenPricing {
		if input == nil || output == nil || cacheInput == nil || cacheOutput == nil {
			return registry.TokenPricing{}, false
		}
		if *input < 0 || *output < 0 || *cacheInput < 0 || *cacheOutput < 0 {
			return registry.TokenPricing{}, false
		}
		return registry.TokenPricing{
			InputPricePerMillion:       *input,
			OutputPricePerMillion:      *output,
			CacheInputPricePerMillion:  *cacheInput,
			CacheOutputPricePerMillion: *cacheOutput,
		}, true
	}
	if modelRatio == nil || completionRatio == nil || *modelRatio < 0 || *completionRatio < 0 {
		return registry.TokenPricing{}, false
	}
	return registry.PricingFromLegacy(*modelRatio, *completionRatio), true
}

type updateDisplayReq struct {
	Model       string `json:"model" binding:"required"`
	DisplayName string `json:"displayName"`
	Enabled     bool   `json:"enabled"`
	marketplaceMetaReq
}

func (h *Handler) updateModelDisplay(c *gin.Context) {
	var req updateDisplayReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if err := h.registry.UpdateDisplay(req.Model, req.DisplayName, req.Enabled); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "model not found"})
		return
	}
	if err := h.updateModelMarketplaceIfProvided(req.Model, req.marketplaceMetaReq); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "model not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

type updateModelIdentityReq struct {
	Model       string `json:"model" binding:"required"`
	NewModel    string `json:"newModel" binding:"required"`
	DisplayName string `json:"displayName"`
	Enabled     bool   `json:"enabled"`
}

func (h *Handler) updateModelIdentity(c *gin.Context) {
	var req updateModelIdentityReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	req.Model = strings.TrimSpace(req.Model)
	req.NewModel = strings.TrimSpace(req.NewModel)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.Model == "" || req.NewModel == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model required"})
		return
	}
	if err := h.registry.UpdateIdentity(req.Model, req.NewModel, req.DisplayName, req.Enabled); err != nil {
		if errors.Is(err, registry.ErrModelConflict) {
			c.JSON(http.StatusConflict, gin.H{"error": "model exists"})
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "model not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

type deleteModelReq struct {
	Model string `json:"model" binding:"required"`
}

func (h *Handler) deleteModel(c *gin.Context) {
	var req deleteModelReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	req.Model = strings.TrimSpace(req.Model)
	if req.Model == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model required"})
		return
	}
	if err := h.registry.Delete(req.Model); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "model not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

type modelStatsRow struct {
	Model             string `json:"model"`
	DisplayName       string `json:"displayName"`
	TotalPoints       int64  `json:"totalPoints"`
	UsageCount        int64  `json:"usageCount"`
	UserCount         int64  `json:"userCount"`
	InputTokens       int64  `json:"inputTokens"`
	OutputTokens      int64  `json:"outputTokens"`
	CacheInputTokens  int64  `json:"cacheInputTokens"`
	CacheOutputTokens int64  `json:"cacheOutputTokens"`
}

func (h *Handler) modelStats(c *gin.Context) {
	modelName := strings.TrimSpace(c.Query("model"))
	if modelName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model required"})
		return
	}
	row := modelStatsRow{Model: modelName}
	var price model.PriceRule
	if err := h.st.DB.First(&price, "model = ?", modelName).Error; err == nil {
		row.DisplayName = price.DisplayName
	}
	if err := h.st.DB.Model(&model.UsageRecord{}).Where("model = ? AND status = ?", modelName, "settled").
		Select("COALESCE(SUM(actual_points),0) AS total_points, COUNT(*) AS usage_count, COUNT(DISTINCT user_id) AS user_count, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cache_input_tokens),0) AS cache_input_tokens, COALESCE(SUM(cache_output_tokens),0) AS cache_output_tokens").
		Scan(&row).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "stats failed"})
		return
	}
	row.Model = modelName
	if row.DisplayName == "" {
		row.DisplayName = price.DisplayName
	}
	c.JSON(http.StatusOK, gin.H{"data": row})
}

func (h *Handler) listEnabledModels(c *gin.Context) {
	rows, err := h.registry.ListEnabled()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	type m struct {
		Model           string `json:"model"`
		DisplayName     string `json:"displayName"`
		MaxOutputTokens int64  `json:"maxOutputTokens"`
	}
	out := make([]m, 0, len(rows))
	for _, r := range rows {
		out = append(out, m{Model: r.Model, DisplayName: r.DisplayName, MaxOutputTokens: r.MaxOutputTokens})
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// atoiDefault：解析 query 整数，失败返回默认值。
func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n := 0
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return def
		}
		n = n*10 + int(ch-'0')
	}
	return n
}

func (h *Handler) analyticsDaily(c *gin.Context) {
	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "from/to required"})
		return
	}
	rows, err := h.analytics.DailyAggregates(from, to)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "daily failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rows})
}

type revByUsersReq struct {
	UserIDs []string `json:"userIds" binding:"required"`
}

func (h *Handler) analyticsRevenueByUsers(c *gin.Context) {
	var req revByUsersReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	m, err := h.analytics.RevenueByUsers(req.UserIDs)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "rbu failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": m})
}

func (h *Handler) analyticsSummaryByUsers(c *gin.Context) {
	var req revByUsersReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	m, err := h.analytics.SummaryByUsers(req.UserIDs)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "summary failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": m})
}

func (h *Handler) analyticsRankings(c *gin.Context) {
	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "from/to required"})
		return
	}
	rows, err := h.analytics.Rankings(from, to, atoiDefault(c.Query("limit"), 10))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "rankings failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rows})
}

func (h *Handler) analyticsSales(c *gin.Context) {
	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "from/to required"})
		return
	}
	rows, err := h.analytics.Sales(from, to)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "sales failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rows})
}

func (h *Handler) analyticsBalances(c *gin.Context) {
	row, err := h.analytics.BalanceSummary()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "balances failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": row})
}

func (h *Handler) analyticsUserSummary(c *gin.Context) {
	userID := c.Query("userId")
	today := c.Query("today")
	if userID == "" || today == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId/today required"})
		return
	}
	row, err := h.analytics.UserSummary(userID, today)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "user summary failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": row})
}

func (h *Handler) listResourcePrices(c *gin.Context) {
	if err := h.resource.EnsureDefaultResourcePrices(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "seed resource prices failed"})
		return
	}
	var rows []model.ResourcePrice
	if err := h.st.DB.Where("resource_key <> ''").Order("resource_key asc").Find(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rows})
}

type upsertResourcePriceReq struct {
	ResourceKey string  `json:"resourceKey" binding:"required"`
	DisplayName string  `json:"displayName"`
	PricingType string  `json:"pricingType" binding:"required"` // PER_CALL|PER_UNIT|VIDEO_IO
	Rate        float64 `json:"rate"`
	OutputRate  float64 `json:"outputRate"` // 仅 VIDEO_IO：输出视频每秒单价
	PerUnits    int64   `json:"perUnits"`
	Enabled     bool    `json:"enabled"`
}

func (h *Handler) upsertResourcePrice(c *gin.Context) {
	var req upsertResourcePriceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	req.ResourceKey = strings.TrimSpace(req.ResourceKey)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.ResourceKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "resourceKey required"})
		return
	}
	if req.PricingType != "PER_CALL" && req.PricingType != "PER_UNIT" && req.PricingType != "VIDEO_IO" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad pricingType"})
		return
	}
	if req.Rate < 0 || req.OutputRate < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "rate must be >= 0"})
		return
	}
	if req.PerUnits <= 0 {
		req.PerUnits = 1
	}
	row := model.ResourcePrice{
		ResourceKey: req.ResourceKey, DisplayName: req.DisplayName, PricingType: req.PricingType,
		Rate: req.Rate, OutputRate: req.OutputRate, PerUnits: req.PerUnits, Enabled: req.Enabled,
	}
	enabled := req.Enabled
	if err := h.st.DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "resource_key"}},
		DoUpdates: clause.AssignmentColumns([]string{"display_name", "pricing_type", "rate", "output_rate", "per_units", "enabled"}),
	}).Create(&row).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upsert failed"})
		return
	}
	if err := h.st.DB.Model(&model.ResourcePrice{}).Where("resource_key = ?", row.ResourceKey).Update("enabled", enabled).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upsert failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

type deleteResourcePriceReq struct {
	ResourceKey string `json:"resourceKey" binding:"required"`
}

func (h *Handler) deleteResourcePrice(c *gin.Context) {
	var req deleteResourcePriceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	req.ResourceKey = strings.TrimSpace(req.ResourceKey)
	if req.ResourceKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "resourceKey required"})
		return
	}
	if err := h.st.DB.Delete(&model.ResourcePrice{}, "resource_key = ?", req.ResourceKey).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func (h *Handler) getRechargeRatio(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ratio": h.resource.RechargeRatio()})
}

type setRatioReq struct {
	Ratio int64 `json:"ratio" binding:"required"`
}

func (h *Handler) setRechargeRatio(c *gin.Context) {
	var req setRatioReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if err := h.resource.SetRechargeRatio(req.Ratio); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func (h *Handler) getRechargePackages(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": h.resource.RechargePackages()})
}

type setRechargePackagesReq struct {
	Packages []resource.RechargePackage `json:"packages"`
}

func (h *Handler) setRechargePackages(c *gin.Context) {
	var req setRechargePackagesReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if err := h.resource.SetRechargePackages(req.Packages); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func (h *Handler) getKbDefaultQuota(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"bytes": h.resource.KbDefaultQuota()})
}

type setKbDefaultQuotaReq struct {
	Bytes int64 `json:"bytes" binding:"required"`
}

func (h *Handler) setKbDefaultQuota(c *gin.Context) {
	var req setKbDefaultQuotaReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if err := h.resource.SetKbDefaultQuota(req.Bytes); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

type adminUpsertMembershipCardReq struct {
	ID           *uint  `json:"id"`
	Name         string `json:"name" binding:"required"`
	PriceFen     int64  `json:"priceFen" binding:"required"`
	DurationDays int    `json:"durationDays" binding:"required"`
	Cadence      string `json:"cadence" binding:"required"`
	GrantPoints  int64  `json:"grantPoints" binding:"required"`
	KbQuotaBytes int64  `json:"kbQuotaBytes"`
	Enabled      bool   `json:"enabled"`
}

func (h *Handler) adminListMembershipCards(c *gin.Context) {
	rows, err := h.membership.ListCards(false)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rows})
}

func (h *Handler) adminUpsertMembershipCard(c *gin.Context) {
	var req adminUpsertMembershipCardReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if req.Cadence != "DAILY" && req.Cadence != "WEEKLY" && req.Cadence != "MONTHLY" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid cadence"})
		return
	}
	card := model.MembershipCard{
		Name:         req.Name,
		PriceFen:     req.PriceFen,
		DurationDays: req.DurationDays,
		Cadence:      req.Cadence,
		GrantPoints:  req.GrantPoints,
		KbQuotaBytes: req.KbQuotaBytes,
		Enabled:      req.Enabled,
	}
	if req.ID != nil {
		card.ID = *req.ID
	}
	if err := h.membership.UpsertCard(&card); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upsert failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

type adminDeleteMembershipCardReq struct {
	ID uint `json:"id" binding:"required"`
}

func (h *Handler) adminDeleteMembershipCard(c *gin.Context) {
	var req adminDeleteMembershipCardReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if err := h.membership.DeleteCard(req.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}
