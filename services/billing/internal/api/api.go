package api

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"ai-assistant-billing/internal/adjust"
	"ai-assistant-billing/internal/analytics"
	"ai-assistant-billing/internal/billingmode"
	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/membership"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/pay"
	"ai-assistant-billing/internal/pointsdetail"
	"ai-assistant-billing/internal/pricing"
	"ai-assistant-billing/internal/redeem"
	"ai-assistant-billing/internal/registry"
	"ai-assistant-billing/internal/resource"
	"ai-assistant-billing/internal/store"
	"ai-assistant-billing/internal/sub"
	"ai-assistant-billing/internal/topup"
	"ai-assistant-billing/internal/videopoint"
	"ai-assistant-billing/internal/wallet"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type Handler struct {
	st          *store.Store
	w           *wallet.Wallet
	epay        *pay.Epay
	topup       *topup.Service
	redeem      *redeem.Service
	sub         *sub.Service
	adjust      *adjust.Service
	registry    *registry.Service
	analytics   *analytics.Service
	resource    *resource.Service
	membership  *membership.Service
	token       string
	pricingMode billingmode.Mode
}

func New(st *store.Store, token string, epay *pay.Epay) *Handler {
	return NewWithPricingMode(st, token, epay, billingmode.Standard)
}

func NewWithPricingMode(st *store.Store, token string, epay *pay.Epay, mode billingmode.Mode) *Handler {
	var topupSvc *topup.Service
	if epay != nil {
		topupSvc = topup.New(st)
	}
	return &Handler{
		st: st, w: wallet.New(st), epay: epay, topup: topupSvc,
		redeem: redeem.New(st), sub: sub.New(st),
		adjust: adjust.New(st), registry: registry.New(st), analytics: analytics.New(st), resource: resource.NewWithPricingMode(st, mode),
		membership: membership.New(st), token: token, pricingMode: mode,
	}
}

func (h *Handler) auth() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("X-Internal-Token") != h.token {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
	}
}

func (h *Handler) Register(r *gin.Engine) {
	// 内部 token 认证组
	r.POST("/reserve", h.auth(), h.reserve)
	r.POST("/settle", h.auth(), h.settle)
	r.GET("/balance/:userId", h.auth(), h.balance)
	r.GET("/points-detail/:userId", h.auth(), h.pointsDetail)
	r.GET("/usage/:userId", h.auth(), h.usage)
	r.GET("/vip/me/:userId", h.auth(), h.vipSummary)
	r.GET("/vip/summary/:userId", h.auth(), h.vipSummary)
	r.GET("/model-marketplace/:userId", h.auth(), h.modelMarketplace)
	r.POST("/topup", h.auth(), h.createTopup)
	r.GET("/topup/:userId/:tradeNo", h.auth(), h.topupOrder)
	r.GET("/recharge-packages", h.auth(), h.listRechargePackages)
	r.POST("/membership/buy", h.auth(), h.buyMembership)
	r.POST("/redeem", h.auth(), h.redeemCode)
	r.POST("/subscription/apply", h.auth(), h.applySubscription)
	r.POST("/charge-points", h.auth(), h.chargePoints)
	r.POST("/resource/charge", h.auth(), h.chargeResource)
	r.POST("/resource/reserve", h.auth(), h.reserveResource)
	r.POST("/resource/settle", h.auth(), h.settleResource)
	r.POST("/resource/settle-video", h.auth(), h.settleVideoResource)
	r.POST("/resource/refund", h.auth(), h.refundResource)

	// 用户端只读端点
	r.GET("/membership/cards", h.auth(), h.listMembershipCards)
	r.GET("/membership/mine/:userId", h.auth(), h.myMemberships)
	r.GET("/user-kb-quota", h.auth(), h.userKbQuota)

	// 易支付回调：公开，靠 Verify 签名验证（无 token）
	if h.epay != nil {
		r.POST("/api/billing/epay/notify", h.epayNotify)
		r.GET("/api/billing/epay/notify", h.epayNotify)
	}

	h.RegisterAdmin(r)
}

type reserveReq struct {
	OperationID     string `json:"operationId" binding:"required"`
	UserID          string `json:"userId" binding:"required"`
	Type            string `json:"type" binding:"required"`
	Model           string `json:"model" binding:"required"`
	InputTokens     int64  `json:"inputTokens"`
	MaxOutputTokens int64  `json:"maxOutputTokens"`
}

type chargeResourceReq struct {
	OperationID string `json:"operationId" binding:"required"`
	UserID      string `json:"userId" binding:"required"`
	ResourceKey string `json:"resourceKey" binding:"required"`
	Units       int64  `json:"units" binding:"required"`
	InputUnits  int64  `json:"inputUnits"` // >0 时走视频复合计价：Units 作输出秒数、InputUnits 作输入视频秒数
	AccountType string `json:"accountType"`
}

type reserveResourceReq struct {
	OperationID string `json:"operationId" binding:"required"`
	UserID      string `json:"userId" binding:"required"`
	ResourceKey string `json:"resourceKey" binding:"required"`
	Units       int64  `json:"units"`
	// 预留有效期（秒，可选）。缺省时由对账兜底按全局 TTL（10 分钟）回收；
	// 生命周期超过该 TTL 的工作流必须显式声明，否则运行途中预留会被按 actual=0
	// 关账，后续真实用量全部免费。
	ReservationTtlSeconds int64 `json:"reservationTtlSeconds"`
}

// 预留有效期上限：足够覆盖桌宠「等待授权 7 天 + 结算宽限」这类最长窗口，
// 同时避免一次笔误把用户的算力点永久冻结在预留里。
const maxReservationTTLSeconds = int64(30 * 24 * 60 * 60)

type settleResourceReq struct {
	OperationID string `json:"operationId" binding:"required"`
	ResourceKey string `json:"resourceKey" binding:"required"`
	Units       int64  `json:"units"`
}

func (h *Handler) chargeResource(c *gin.Context) {
	var req chargeResourceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if req.Units <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid units"})
		return
	}
	// 按账户类型路由：视频点走 ChargeVideo（扣视频点余额），算力点走 Charge（含 VIP 折扣）
	accountType := req.AccountType
	if accountType == "" {
		accountType = "points"
	}
	if accountType != "points" && accountType != "video" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid account type"})
		return
	}

	if req.InputUnits < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid inputUnits"})
		return
	}

	var cost int64
	var err error
	switch {
	case accountType == "video" && req.InputUnits > 0:
		cost, err = h.resource.ChargeVideoIO(req.OperationID, req.UserID, req.ResourceKey, req.InputUnits, req.Units)
	case accountType == "video":
		cost, err = h.resource.ChargeVideo(req.OperationID, req.UserID, req.ResourceKey, req.Units)
	default:
		cost, err = h.resource.Charge(req.OperationID, req.UserID, req.ResourceKey, req.Units)
	}
	if err == resource.ErrInsufficient {
		c.JSON(http.StatusPaymentRequired, gin.H{"error": "insufficient", "code": "INSUFFICIENT_BALANCE"})
		return
	}
	if err == resource.ErrResourceNotPriced {
		c.JSON(http.StatusBadRequest, gin.H{"error": "resource not priced"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "charge failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"charged": cost})
}

type settleVideoResourceReq struct {
	OperationID string `json:"operationId" binding:"required"`
	ResourceKey string `json:"resourceKey" binding:"required"`
	Units       int64  `json:"units"`      // 实际输出秒
	InputUnits  int64  `json:"inputUnits"` // 输入视频秒（无输入视频为 0）
}

func (h *Handler) settleVideoResource(c *gin.Context) {
	var req settleVideoResourceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if req.Units < 0 || req.InputUnits < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid units"})
		return
	}
	settled, err := h.resource.SettleVideoIO(req.OperationID, req.ResourceKey, req.InputUnits, req.Units)
	if err == resource.ErrResourceNotPriced {
		c.JSON(http.StatusBadRequest, gin.H{"error": "resource not priced"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settle video failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"settled": settled})
}

func (h *Handler) reserveResource(c *gin.Context) {
	var req reserveResourceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if req.Units <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid units"})
		return
	}
	if req.ReservationTtlSeconds < 0 || req.ReservationTtlSeconds > maxReservationTTLSeconds {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid reservation ttl"})
		return
	}
	reserved, err := h.resource.ReserveFor(
		req.OperationID, req.UserID, req.ResourceKey, req.Units,
		time.Duration(req.ReservationTtlSeconds)*time.Second,
	)
	if errors.Is(err, resource.ErrInsufficient) {
		c.JSON(http.StatusPaymentRequired, gin.H{"error": "insufficient", "code": "INSUFFICIENT_BALANCE"})
		return
	}
	if errors.Is(err, resource.ErrResourceNotPriced) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "resource not priced"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "reserve resource failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"reserved": reserved})
}

func (h *Handler) settleResource(c *gin.Context) {
	var req settleResourceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if req.Units < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid units"})
		return
	}
	settled, err := h.resource.Settle(req.OperationID, req.ResourceKey, req.Units)
	if errors.Is(err, resource.ErrResourceNotPriced) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "resource not priced"})
		return
	}
	if errors.Is(err, wallet.ErrNotReserved) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "resource not reserved"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settle resource failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"settled": settled})
}

type refundResourceReq struct {
	OperationID string `json:"operationId" binding:"required"`
}

func (h *Handler) refundResource(c *gin.Context) {
	var req refundResourceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if err := h.resource.RefundCharge(req.OperationID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "refund failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func (h *Handler) loadRuleAndGroup(userID, modelName string) (pricing.Rule, float64, bool) {
	var pr model.PriceRule
	if err := h.st.DB.First(&pr, "model = ? AND enabled = true", modelName).Error; err != nil {
		return pricing.Rule{}, 0, false
	}
	if err := h.registry.NormalizeAndApply(&pr); err != nil {
		return pricing.Rule{}, 0, false
	}
	var acc model.Account
	gr := 1.0
	if err := h.st.DB.First(&acc, "user_id = ?", userID).Error; err == nil && acc.GroupRatio > 0 {
		gr = acc.GroupRatio
	}
	return pricing.Rule{
		ModelRatio:                 pr.ModelRatio,
		CompletionRatio:            pr.CompletionRatio,
		InputPricePerMillion:       pr.InputPricePerMillion,
		OutputPricePerMillion:      pr.OutputPricePerMillion,
		CacheInputPricePerMillion:  pr.CacheInputPricePerMillion,
		CacheOutputPricePerMillion: pr.CacheOutputPricePerMillion,
	}, gr, true
}

func (h *Handler) reserve(c *gin.Context) {
	var req reserveReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	rule, gr, ok := h.loadRuleAndGroup(req.UserID, req.Model)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model not priced"})
		return
	}
	est := h.pricingMode.NormalizeCost(pricing.ReserveQuota(rule, req.InputTokens, req.MaxOutputTokens, gr))
	reserved, err := h.w.Reserve(req.OperationID, req.UserID, req.Type, req.Model, est)
	if err == wallet.ErrInsufficient {
		c.JSON(http.StatusPaymentRequired, gin.H{"error": "insufficient", "code": "INSUFFICIENT_BALANCE"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "reserve failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"reserved": reserved})
}

type settleReq struct {
	OperationID       string `json:"operationId" binding:"required"`
	Model             string `json:"model" binding:"required"`
	UserID            string `json:"userId" binding:"required"`
	InputTokens       int64  `json:"inputTokens"`
	OutputTokens      int64  `json:"outputTokens"`
	CacheInputTokens  int64  `json:"cacheInputTokens"`
	CacheOutputTokens int64  `json:"cacheOutputTokens"`
}

func (h *Handler) settle(c *gin.Context) {
	var req settleReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	rule, gr, ok := h.loadRuleAndGroup(req.UserID, req.Model)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "model not priced"})
		return
	}
	actual := h.pricingMode.NormalizeCost(pricing.ChatQuota(rule, pricing.Usage{
		InputTokens:       req.InputTokens,
		OutputTokens:      req.OutputTokens,
		CacheInputTokens:  req.CacheInputTokens,
		CacheOutputTokens: req.CacheOutputTokens,
	}, gr))
	if err := h.w.SettleWithTokens(req.OperationID, actual, wallet.TokenUsage{
		InputTokens:       req.InputTokens,
		OutputTokens:      req.OutputTokens,
		CacheInputTokens:  req.CacheInputTokens,
		CacheOutputTokens: req.CacheOutputTokens,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "settle failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"settled": actual})
}

func (h *Handler) balance(c *gin.Context) {
	b, err := bucket.Balance(h.st.DB, c.Param("userId"))
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"balance": 0, "videoBalance": 0})
		return
	}
	videoBalance, err := videopoint.Balance(h.st.DB, c.Param("userId"))
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"balance": b, "videoBalance": 0})
		return
	}
	c.JSON(http.StatusOK, gin.H{"balance": b, "videoBalance": videoBalance})
}

func (h *Handler) pointsDetail(c *gin.Context) {
	userID := c.Param("userId")
	now := time.Now()
	d, err := pointsdetail.Compute(h.st.DB, userID, now)
	if err != nil {
		// 只读接口失败不阻塞页面，返回零值让前端降级
		c.JSON(http.StatusOK, gin.H{
			"totalPoints": 0, "permanentPoints": 0, "membershipPoints": 0,
			"videoBalance": 0, "currentPeriod": nil, "membership": nil,
		})
		return
	}
	video, err := videopoint.Balance(h.st.DB, userID)
	if err != nil {
		video = 0
	}
	resp := gin.H{
		"totalPoints": d.TotalPoints, "permanentPoints": d.PermanentPoints,
		"membershipPoints": d.MembershipPoints, "videoBalance": video,
		"currentPeriod": nil, "membership": nil,
	}
	if d.Period.Has {
		resp["currentPeriod"] = gin.H{
			"granted": d.Period.Granted, "remaining": d.Period.Remaining,
			"used": d.Period.Used, "expiresAt": d.Period.ExpiresAt,
		}
	}
	if d.Membership.Has {
		resp["membership"] = gin.H{
			"cardName": d.Membership.CardName, "cadence": d.Membership.Cadence,
			"expiresAt": d.Membership.ExpiresAt,
		}
	}
	c.JSON(http.StatusOK, resp)
}

type topupOrderRow struct {
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

func (h *Handler) topupOrder(c *gin.Context) {
	userID := c.Param("userId")
	tradeNo := c.Param("tradeNo")
	if userID == "" || tradeNo == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}

	var row model.TopUp
	if err := h.st.DB.First(&row, "user_id = ? AND trade_no = ?", userID, tradeNo).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "order not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "query order failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": topupOrderRow{
		ID:            row.ID,
		TradeNo:       row.TradeNo,
		UserID:        row.UserID,
		AmountFen:     row.AmountFen,
		Points:        row.Points,
		Provider:      row.Provider,
		PaymentMethod: row.PaymentMethod,
		Status:        row.Status,
		Kind:          row.Kind,
		CardID:        row.CardID,
		CreatedAt:     row.CreatedAt,
		PaidAt:        row.PaidAt,
	}})
}

func (h *Handler) usage(c *gin.Context) {
	limit := 20
	if raw := c.Query("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	var rows []model.UsageRecord
	if err := h.st.DB.
		Where("user_id = ?", c.Param("userId")).
		Order("created_at DESC").
		Limit(limit).
		Find(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "usage query failed"})
		return
	}

	type usageRow struct {
		OperationID       string     `json:"operationId"`
		Type              string     `json:"type"`
		Model             string     `json:"model"`
		DisplayName       string     `json:"displayName"`
		Status            string     `json:"status"`
		ReservedPoints    int64      `json:"reservedPoints"`
		ActualPoints      int64      `json:"actualPoints"`
		OriginalPoints    int64      `json:"originalPoints"`
		VipLevelName      string     `json:"vipLevelName"`
		VipDiscountBps    int        `json:"vipDiscountBps"`
		VipSavedPoints    int64      `json:"vipSavedPoints"`
		VipGrowthPoints   int64      `json:"vipGrowthPoints"`
		InputTokens       int64      `json:"inputTokens"`
		OutputTokens      int64      `json:"outputTokens"`
		CacheInputTokens  int64      `json:"cacheInputTokens"`
		CacheOutputTokens int64      `json:"cacheOutputTokens"`
		CreatedAt         time.Time  `json:"createdAt"`
		SettledAt         *time.Time `json:"settledAt"`
	}
	displayNames := h.usageDisplayNames(rows)
	data := make([]usageRow, 0, len(rows))
	for _, row := range rows {
		displayName := displayNames[row.Model]
		if displayName == "" {
			displayName = row.Model
		}
		data = append(data, usageRow{
			OperationID:       row.OperationID,
			Type:              row.Type,
			Model:             row.Model,
			DisplayName:       displayName,
			Status:            row.Status,
			ReservedPoints:    row.ReservedPoints,
			ActualPoints:      row.ActualPoints,
			OriginalPoints:    row.OriginalPoints,
			VipLevelName:      row.VipLevelName,
			VipDiscountBps:    row.VipDiscountBps,
			VipSavedPoints:    row.VipSavedPoints,
			VipGrowthPoints:   row.VipGrowthPoints,
			InputTokens:       row.InputTokens,
			OutputTokens:      row.OutputTokens,
			CacheInputTokens:  row.CacheInputTokens,
			CacheOutputTokens: row.CacheOutputTokens,
			CreatedAt:         row.CreatedAt,
			SettledAt:         row.SettledAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": data})
}

func (h *Handler) usageDisplayNames(rows []model.UsageRecord) map[string]string {
	keys := make([]string, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		if row.Model == "" {
			continue
		}
		if _, ok := seen[row.Model]; ok {
			continue
		}
		seen[row.Model] = struct{}{}
		keys = append(keys, row.Model)
	}
	if len(keys) == 0 {
		return map[string]string{}
	}

	names := make(map[string]string, len(keys))
	var priceRows []model.PriceRule
	if err := h.st.DB.Select("model", "display_name").Where("model IN ?", keys).Find(&priceRows).Error; err == nil {
		for _, row := range priceRows {
			if row.DisplayName != "" {
				names[row.Model] = row.DisplayName
			}
		}
	}
	var resourceRows []model.ResourcePrice
	if err := h.st.DB.Select("resource_key", "display_name").Where("resource_key IN ?", keys).Find(&resourceRows).Error; err == nil {
		for _, row := range resourceRows {
			if row.DisplayName != "" {
				names[row.ResourceKey] = row.DisplayName
			}
		}
	}
	return names
}

// collectParams 从 POST form 或 GET query 收集参数（易支付可能用任一方式）
func collectParams(c *gin.Context) map[string]string {
	params := make(map[string]string)

	// GET 参数
	for k, v := range c.Request.URL.Query() {
		if len(v) > 0 {
			params[k] = v[0]
		}
	}

	// POST form 参数（覆盖 GET）
	if c.Request.Method == "POST" {
		if err := c.Request.ParseForm(); err == nil {
			for k, v := range c.Request.PostForm {
				if len(v) > 0 {
					params[k] = v[0]
				}
			}
		}
	}

	return params
}

// epayNotify 易支付回调：验签 + 幂等到账
func (h *Handler) epayNotify(c *gin.Context) {
	params := collectParams(c)
	if len(params) == 0 {
		c.String(http.StatusOK, "fail")
		return
	}

	// 验签
	verify, err := h.epay.Client().Verify(params)
	if err != nil || !verify.VerifyStatus {
		c.String(http.StatusOK, "fail")
		return
	}

	// 检查交易状态
	if verify.TradeStatus != "TRADE_SUCCESS" {
		c.String(http.StatusOK, "fail")
		return
	}

	// 到账：幂等 + 锁单 + 状态门
	// 分派：membership 分派到激活，points 分派到 bucket.GrantPoints（在 topup.CreditByTradeNoWith 内处理）
	onMembership := func(tx *gorm.DB, o *model.TopUp) error {
		return h.activateMembershipOrderInTx(tx, o, time.Now())
	}
	if err := h.topup.CreditByTradeNoWith(verify.ServiceTradeNo, verify.Type, onMembership); err != nil {
		c.String(http.StatusOK, "fail")
		return
	}

	// 易支付要求回 "success" 文本
	c.String(http.StatusOK, "success")
}

type redeemReq struct {
	Code   string `json:"code" binding:"required"`
	UserID string `json:"userId" binding:"required"`
}

func (h *Handler) redeemCode(c *gin.Context) {
	var req redeemReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if err := h.redeem.Redeem(req.Code, req.UserID); err != nil {
		if err == redeem.ErrInvalidCode {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid code"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "redeem failed"})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

type topupReq struct {
	UserID      string `json:"userId" binding:"required"`
	AmountFen   int64  `json:"amountFen"`
	PackageID   string `json:"packageId"`
	Method      string `json:"method" binding:"required"` // alipay|wxpay
	AccountType string `json:"accountType"`
}

func (h *Handler) createTopup(c *gin.Context) {
	if h.epay == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "payment not configured"})
		return
	}
	var req topupReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if req.Method != "alipay" && req.Method != "wxpay" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payment method"})
		return
	}
	amountFen := req.AmountFen
	points := int64(0)
	subject := "积分充值"
	kind := "points"
	accountType := req.AccountType
	if accountType == "" {
		accountType = "points"
	}
	switch accountType {
	case "points":
	case "video":
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid account type"})
		return
	}
	if accountType == "video" {
		if req.PackageID != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "video points do not support recharge packages"})
			return
		}
		if amountFen <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid amount"})
			return
		}
		points = amountFen * videopoint.FixedPointsPerYuan / 100
		subject = "视频点充值"
		kind = videopoint.TopUpKind
	} else if req.PackageID != "" {
		pkg, ok := h.resource.FindEnabledRechargePackage(req.PackageID)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recharge package"})
			return
		}
		amountFen = pkg.AmountFen
		points = pkg.Points
		subject = pkg.Name
	} else {
		if amountFen <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid amount"})
			return
		}
		points = h.resource.PointsForAmount(amountFen)
	}
	if points <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid points"})
		return
	}
	tradeNo := pay.GenTradeNo()
	topupOrder := &model.TopUp{
		TradeNo:       tradeNo,
		UserID:        req.UserID,
		AmountFen:     amountFen,
		Points:        points,
		Kind:          kind,
		Provider:      "epay",
		PaymentMethod: req.Method,
		Status:        "pending",
	}
	if err := h.topup.CreateOrder(topupOrder); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "create order failed"})
		return
	}
	payUrl, err := h.epay.Purchase(tradeNo, subject, amountFen, req.Method)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "generate payment url failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"payUrl": payUrl, "tradeNo": tradeNo})
}

func (h *Handler) listRechargePackages(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": h.resource.EnabledRechargePackages()})
}

type buyMembershipReq struct {
	UserID string `json:"userId" binding:"required"`
	CardID uint   `json:"cardId" binding:"required"`
	Method string `json:"method"` // alipay|wxpay，默认 alipay
}

func (h *Handler) buyMembership(c *gin.Context) {
	if h.epay == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "payment not configured"})
		return
	}
	var req buyMembershipReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if req.Method == "" {
		req.Method = "alipay"
	}
	if req.Method != "alipay" && req.Method != "wxpay" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payment method"})
		return
	}

	// 查启用卡
	card, err := h.membership.GetCard(req.CardID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "card not found"})
		return
	}
	if !card.Enabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "card not enabled"})
		return
	}

	// 建 TopUp
	tradeNo := pay.GenTradeNo()
	topupOrder := &model.TopUp{
		TradeNo:       tradeNo,
		UserID:        req.UserID,
		AmountFen:     card.PriceFen,
		Points:        0,
		Kind:          "membership",
		CardID:        card.ID,
		Provider:      "epay",
		PaymentMethod: req.Method,
		Status:        "pending",
	}
	if err := h.topup.CreateOrder(topupOrder); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "create order failed"})
		return
	}

	// 调易支付
	payUrl, err := h.epay.Purchase(tradeNo, card.Name, card.PriceFen, req.Method)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "generate payment url failed"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"payUrl": payUrl, "tradeNo": tradeNo})
}

type subscriptionReq struct {
	UserID string `json:"userId" binding:"required"`
	Plan   string `json:"plan" binding:"required"`
}

func (h *Handler) applySubscription(c *gin.Context) {
	var req subscriptionReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if err := h.sub.ApplyPlan(req.UserID, req.Plan); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func (h *Handler) listMembershipCards(c *gin.Context) {
	cards, err := h.membership.ListCards(true)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "list cards failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": cards})
}

func (h *Handler) myMemberships(c *gin.Context) {
	userID := c.Param("userId")
	memberships, err := h.membership.MyMemberships(userID, time.Now())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "list memberships failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": memberships})
}

type chargePointsReq struct {
	OperationID string `json:"operationId" binding:"required"`
	UserID      string `json:"userId" binding:"required"`
	Points      int64  `json:"points" binding:"required"`
	Kind        string `json:"kind" binding:"required"`
}

func (h *Handler) chargePoints(c *gin.Context) {
	var req chargePointsReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	points := h.pricingMode.NormalizeCost(req.Points)
	err := wallet.ChargePoints(h.st.DB, req.OperationID, req.UserID, points, req.Kind)
	if err == wallet.ErrInsufficient {
		c.JSON(http.StatusPaymentRequired, gin.H{"error": "insufficient", "code": "INSUFFICIENT_BALANCE"})
		return
	}
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"charged": points})
}

type userKbQuotaResp struct {
	MembershipBytes int64 `json:"membershipBytes"`
	DefaultBytes    int64 `json:"defaultBytes"`
}

func (h *Handler) userKbQuota(c *gin.Context) {
	userID := c.Query("userId")
	if userID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId required"})
		return
	}
	membershipBytes, err := h.membership.UserKbQuotaBytes(userID, time.Now())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "query membership quota failed"})
		return
	}
	defaultBytes := h.resource.KbDefaultQuota()
	c.JSON(http.StatusOK, userKbQuotaResp{
		MembershipBytes: membershipBytes,
		DefaultBytes:    defaultBytes,
	})
}
