package analytics

import (
	"fmt"

	"yc-billing/internal/store"
)

type Service struct{ st *store.Store }

func New(st *store.Store) *Service { return &Service{st: st} }

type DailyRow struct {
	Date           string `json:"date"`
	RevenueFen     int64  `json:"revenueFen"`
	TopupCount     int64  `json:"topupCount"`
	GrantedPoints  int64  `json:"grantedPoints"`
	ConsumedPoints int64  `json:"consumedPoints"`
	PayingUsers    int64  `json:"payingUsers"`
	NewPayingUsers int64  `json:"newPayingUsers"`
}

type RevenueEvent struct {
	PaidAtDate string `json:"paidAtDate"` // YYYY-MM-DD（UTC）
	AmountFen  int64  `json:"amountFen"`
	Points     int64  `json:"points"`
}

type RankingRow struct {
	Key    string `json:"key"`
	Points int64  `json:"points"`
	Tokens int64  `json:"tokens"`
	Count  int64  `json:"count"`
}

type RankingsSummary struct {
	Users    []RankingRow `json:"users"`
	Models   []RankingRow `json:"models"`
	Features []RankingRow `json:"features"`
}

type SalesRow struct {
	Key        string `json:"key"`
	Name       string `json:"name"`
	Orders     int64  `json:"orders"`
	Users      int64  `json:"users"`
	RevenueFen int64  `json:"revenueFen"`
	Points     int64  `json:"points"`
}

type SalesSummary struct {
	Memberships      []SalesRow `json:"memberships"`
	RechargePackages []SalesRow `json:"rechargePackages"`
}

type BalanceSummary struct {
	TotalBalance       int64 `json:"totalBalance"`       // 算力点存活总余额
	UsersWithBalance   int64 `json:"usersWithBalance"`   // 有算力点余额的用户数
	VideoPointsBalance int64 `json:"videoPointsBalance"` // 视频点总余额（独立账户）
}

type UserSummary struct {
	TodayRechargeFen       int64 `json:"todayRechargeFen"`
	TodayRechargeOrders    int64 `json:"todayRechargeOrders"`
	TotalRechargeFen       int64 `json:"totalRechargeFen"`
	TotalRechargeOrders    int64 `json:"totalRechargeOrders"`
	TodayConsumptionPoints int64 `json:"todayConsumptionPoints"`
	TotalConsumptionPoints int64 `json:"totalConsumptionPoints"`
	TodayTokens            int64 `json:"todayTokens"`
	TotalTokens            int64 `json:"totalTokens"`
}

type UserAggRow struct {
	TotalRechargeFen       int64 `json:"totalRechargeFen"`
	TotalRechargeOrders    int64 `json:"totalRechargeOrders"`
	TotalConsumptionPoints int64 `json:"totalConsumptionPoints"`
}

// DailyAggregates 汇总 [from,to]（含端点，YYYY-MM-DD）每日成功充值与消耗。
// 按 UTC 日归集（to_char(paid_at,'YYYY-MM-DD')）。
func (s *Service) DailyAggregates(from, to string) ([]DailyRow, error) {
	type acc struct {
		Date                                                  string
		RevenueFen, TopupCount, GrantedPoints, ConsumedPoints int64
		PayingUsers, NewPayingUsers                           int64
	}
	out := map[string]*acc{}
	get := func(d string) *acc {
		if out[d] == nil {
			out[d] = &acc{Date: d}
		}
		return out[d]
	}

	// 成功充值：金额/笔数/到账积分 + 当日付费去重人数
	type r1 struct {
		D                     string
		Rev, Cnt, Pts, Payers int64
	}
	var rows1 []r1
	if err := s.st.DB.Raw(`
		SELECT to_char(paid_at,'YYYY-MM-DD') AS d,
		       COALESCE(SUM(amount_fen),0) AS rev, COUNT(*) AS cnt,
		       COALESCE(SUM(points),0) AS pts, COUNT(DISTINCT user_id) AS payers
		FROM top_ups
		WHERE status='success' AND paid_at IS NOT NULL
		  AND to_char(paid_at,'YYYY-MM-DD') BETWEEN ? AND ?
		GROUP BY d`, from, to).Scan(&rows1).Error; err != nil {
		return nil, err
	}
	for _, r := range rows1 {
		a := get(r.D)
		a.RevenueFen, a.TopupCount, a.GrantedPoints, a.PayingUsers = r.Rev, r.Cnt, r.Pts, r.Payers
	}

	// 新增付费：按 user 首笔成功充值日归集
	type r2 struct {
		D   string
		Cnt int64
	}
	var rows2 []r2
	if err := s.st.DB.Raw(`
		SELECT to_char(first_paid,'YYYY-MM-DD') AS d, COUNT(*) AS cnt
		FROM (
		  SELECT user_id, MIN(paid_at) AS first_paid
		  FROM top_ups WHERE status='success' AND paid_at IS NOT NULL
		  GROUP BY user_id
		) t
		WHERE to_char(first_paid,'YYYY-MM-DD') BETWEEN ? AND ?
		GROUP BY d`, from, to).Scan(&rows2).Error; err != nil {
		return nil, err
	}
	for _, r := range rows2 {
		get(r.D).NewPayingUsers = r.Cnt
	}

	// 消耗：按 settled_at 日归集 actual_points
	type r3 struct {
		D   string
		Pts int64
	}
	var rows3 []r3
	if err := s.st.DB.Raw(`
		SELECT to_char(settled_at,'YYYY-MM-DD') AS d, COALESCE(SUM(actual_points),0) AS pts
		FROM usage_records
		WHERE status='settled' AND settled_at IS NOT NULL
		  AND to_char(settled_at,'YYYY-MM-DD') BETWEEN ? AND ?
		GROUP BY d`, from, to).Scan(&rows3).Error; err != nil {
		return nil, err
	}
	for _, r := range rows3 {
		get(r.D).ConsumedPoints = r.Pts
	}

	res := make([]DailyRow, 0, len(out))
	for _, a := range out {
		res = append(res, DailyRow{
			Date: a.Date, RevenueFen: a.RevenueFen, TopupCount: a.TopupCount,
			GrantedPoints: a.GrantedPoints, ConsumedPoints: a.ConsumedPoints,
			PayingUsers: a.PayingUsers, NewPayingUsers: a.NewPayingUsers,
		})
	}
	return res, nil
}

// RevenueByUsers 返回给定用户的成功充值事件（按 UTC 日）。空集合返回空 map。
func (s *Service) RevenueByUsers(userIds []string) (map[string][]RevenueEvent, error) {
	res := map[string][]RevenueEvent{}
	if len(userIds) == 0 {
		return res, nil
	}
	type row struct {
		UserID    string
		D         string
		AmountFen int64
		Points    int64
	}
	var rows []row
	if err := s.st.DB.Raw(`
		SELECT user_id, to_char(paid_at,'YYYY-MM-DD') AS d, amount_fen, points
		FROM top_ups
		WHERE status='success' AND paid_at IS NOT NULL AND user_id IN ?
		ORDER BY paid_at ASC`, userIds).Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, r := range rows {
		res[r.UserID] = append(res[r.UserID], RevenueEvent{PaidAtDate: r.D, AmountFen: r.AmountFen, Points: r.Points})
	}
	return res, nil
}

func (s *Service) Rankings(from, to string, limit int) (RankingsSummary, error) {
	if limit <= 0 {
		limit = 10
	}
	if limit > 100 {
		limit = 100
	}
	users, err := s.rankBy("user_id", from, to, limit)
	if err != nil {
		return RankingsSummary{}, err
	}
	models, err := s.rankBy("model", from, to, limit)
	if err != nil {
		return RankingsSummary{}, err
	}
	features, err := s.rankBy("type", from, to, limit)
	if err != nil {
		return RankingsSummary{}, err
	}
	return RankingsSummary{Users: users, Models: models, Features: features}, nil
}

func (s *Service) rankBy(column, from, to string, limit int) ([]RankingRow, error) {
	query := fmt.Sprintf(`
		SELECT %s AS key,
		       COALESCE(SUM(actual_points),0) AS points,
		       COALESCE(SUM(input_tokens + output_tokens + cache_input_tokens + cache_output_tokens),0) AS tokens,
		       COUNT(*) AS count
		FROM usage_records
		WHERE status='settled' AND settled_at IS NOT NULL
		  AND to_char(settled_at,'YYYY-MM-DD') BETWEEN ? AND ?
		GROUP BY %s
		ORDER BY points DESC, count DESC, key ASC
		LIMIT ?`, column, column)
	var rows []RankingRow
	if err := s.st.DB.Raw(query, from, to, limit).Scan(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *Service) Sales(from, to string) (SalesSummary, error) {
	memberships, err := s.membershipSales(from, to)
	if err != nil {
		return SalesSummary{}, err
	}
	packages, err := s.rechargePackageSales(from, to)
	if err != nil {
		return SalesSummary{}, err
	}
	return SalesSummary{Memberships: memberships, RechargePackages: packages}, nil
}

func (s *Service) membershipSales(from, to string) ([]SalesRow, error) {
	type row struct {
		Key        string
		Name       string
		Orders     int64
		Users      int64
		RevenueFen int64
		Points     int64
	}
	var rows []row
	if err := s.st.DB.Raw(`
		SELECT CAST(t.card_id AS text) AS key,
		       COALESCE(NULLIF(c.name, ''), '会员套餐') AS name,
		       COUNT(*) AS orders,
		       COUNT(DISTINCT t.user_id) AS users,
		       COALESCE(SUM(t.amount_fen),0) AS revenue_fen,
		       COALESCE(SUM(t.points),0) AS points
		FROM top_ups t
		LEFT JOIN membership_cards c ON c.id = t.card_id
		WHERE t.status='success' AND t.kind='membership' AND t.paid_at IS NOT NULL
		  AND to_char(t.paid_at,'YYYY-MM-DD') BETWEEN ? AND ?
		GROUP BY t.card_id, c.name
		ORDER BY revenue_fen DESC, orders DESC`, from, to).Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]SalesRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, SalesRow(r))
	}
	return out, nil
}

func (s *Service) rechargePackageSales(from, to string) ([]SalesRow, error) {
	type row struct {
		Key        string
		AmountFen  int64
		Orders     int64
		Users      int64
		RevenueFen int64
		Points     int64
	}
	var rows []row
	if err := s.st.DB.Raw(`
		SELECT CONCAT(amount_fen, ':', points) AS key,
		       amount_fen,
		       COUNT(*) AS orders,
		       COUNT(DISTINCT user_id) AS users,
		       COALESCE(SUM(amount_fen),0) AS revenue_fen,
		       COALESCE(SUM(points),0) AS points
		FROM top_ups
		WHERE status='success' AND kind='points' AND paid_at IS NOT NULL
		  AND to_char(paid_at,'YYYY-MM-DD') BETWEEN ? AND ?
		GROUP BY amount_fen, points
		ORDER BY revenue_fen DESC, orders DESC`, from, to).Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]SalesRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, SalesRow{
			Key:        r.Key,
			Name:       fmt.Sprintf("¥%.2f / %d 点", float64(r.AmountFen)/100, r.Points/int64(max(r.Orders, 1))),
			Orders:     r.Orders,
			Users:      r.Users,
			RevenueFen: r.RevenueFen,
			Points:     r.Points,
		})
	}
	return out, nil
}

func (s *Service) BalanceSummary() (BalanceSummary, error) {
	var row BalanceSummary
	if err := s.st.DB.Raw(`
		SELECT COALESCE(SUM(remaining),0) AS total_balance,
		       COUNT(DISTINCT user_id) FILTER (WHERE remaining > 0) AS users_with_balance
		FROM point_buckets
		WHERE remaining > 0 AND (expires_at IS NULL OR expires_at > NOW())`).Scan(&row).Error; err != nil {
		return BalanceSummary{}, err
	}
	// 视频点为独立账户，单独汇总
	if err := s.st.DB.Raw(`
		SELECT COALESCE(SUM(balance),0) FROM video_point_accounts WHERE balance > 0`).
		Scan(&row.VideoPointsBalance).Error; err != nil {
		return BalanceSummary{}, err
	}
	return row, nil
}

func (s *Service) UserSummary(userID, today string) (UserSummary, error) {
	var topups struct {
		TodayRevenueFen int64
		TodayOrders     int64
		TotalRevenueFen int64
		TotalOrders     int64
	}
	if err := s.st.DB.Raw(`
		SELECT COALESCE(SUM(amount_fen) FILTER (WHERE to_char(paid_at,'YYYY-MM-DD') = ?),0) AS today_revenue_fen,
		       COUNT(*) FILTER (WHERE to_char(paid_at,'YYYY-MM-DD') = ?) AS today_orders,
		       COALESCE(SUM(amount_fen),0) AS total_revenue_fen,
		       COUNT(*) AS total_orders
		FROM top_ups
		WHERE user_id = ? AND status='success' AND paid_at IS NOT NULL`, today, today, userID).Scan(&topups).Error; err != nil {
		return UserSummary{}, err
	}
	var usage struct {
		TodayPoints int64
		TotalPoints int64
		TodayTokens int64
		TotalTokens int64
	}
	if err := s.st.DB.Raw(`
		SELECT COALESCE(SUM(actual_points) FILTER (WHERE to_char(settled_at,'YYYY-MM-DD') = ?),0) AS today_points,
		       COALESCE(SUM(actual_points),0) AS total_points,
		       COALESCE(SUM(input_tokens + output_tokens + cache_input_tokens + cache_output_tokens) FILTER (WHERE to_char(settled_at,'YYYY-MM-DD') = ?),0) AS today_tokens,
		       COALESCE(SUM(input_tokens + output_tokens + cache_input_tokens + cache_output_tokens),0) AS total_tokens
		FROM usage_records
		WHERE user_id = ? AND status='settled' AND settled_at IS NOT NULL`, today, today, userID).Scan(&usage).Error; err != nil {
		return UserSummary{}, err
	}
	return UserSummary{
		TodayRechargeFen:       topups.TodayRevenueFen,
		TodayRechargeOrders:    topups.TodayOrders,
		TotalRechargeFen:       topups.TotalRevenueFen,
		TotalRechargeOrders:    topups.TotalOrders,
		TodayConsumptionPoints: usage.TodayPoints,
		TotalConsumptionPoints: usage.TotalPoints,
		TodayTokens:            usage.TodayTokens,
		TotalTokens:            usage.TotalTokens,
	}, nil
}

// SummaryByUsers 批量返回给定用户的累计充值(成功)与消耗(结算)。无数据的用户不出现在 map 中。
func (s *Service) SummaryByUsers(userIDs []string) (map[string]UserAggRow, error) {
	out := map[string]UserAggRow{}
	if len(userIDs) == 0 {
		return out, nil
	}
	var recs []struct {
		UserID string
		Fen    int64
		Orders int64
	}
	if err := s.st.DB.Raw(`
		SELECT user_id AS user_id, COALESCE(SUM(amount_fen),0) AS fen, COUNT(*) AS orders
		FROM top_ups WHERE user_id IN ? AND status='success' AND paid_at IS NOT NULL
		GROUP BY user_id`, userIDs).Scan(&recs).Error; err != nil {
		return nil, err
	}
	for _, r := range recs {
		out[r.UserID] = UserAggRow{TotalRechargeFen: r.Fen, TotalRechargeOrders: r.Orders}
	}
	var used []struct {
		UserID string
		Points int64
	}
	if err := s.st.DB.Raw(`
		SELECT user_id AS user_id, COALESCE(SUM(actual_points),0) AS points
		FROM usage_records WHERE user_id IN ? AND status='settled' AND settled_at IS NOT NULL
		GROUP BY user_id`, userIDs).Scan(&used).Error; err != nil {
		return nil, err
	}
	for _, u := range used {
		row := out[u.UserID]
		row.TotalConsumptionPoints = u.Points
		out[u.UserID] = row
	}
	return out, nil
}
