package membership

import (
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"yc-billing/internal/bucket"
	"yc-billing/internal/model"
	"yc-billing/internal/store"
)

type Service struct{ st *store.Store }

func New(st *store.Store) *Service { return &Service{st: st} }

// BeijingLoc 东八区固定偏移。会员周期统一按北京时区锚定日界：中国无夏令时，
// 固定 +8 恒成立，用 FixedZone 免 tzdata 依赖（billing 是 distroless 镜像，无系统时区库）。
var BeijingLoc = time.FixedZone("CST", 8*3600)

// PeriodKeyAndExpiry 按 cadence 算当期键与期末过期时间（统一按北京时区，与 cron 触发日界一致）。
func PeriodKeyAndExpiry(cadence string, t time.Time) (string, time.Time) {
	t = t.In(BeijingLoc)
	loc := BeijingLoc
	y, m, d := t.Date()
	switch cadence {
	case "WEEKLY":
		iy, iw := t.ISOWeek()
		// 到下周一 0 点：周一=1..周日=0
		wd := int(t.Weekday())
		days := (8 - wd) % 7
		if days == 0 {
			days = 7
		}
		exp := time.Date(y, m, d, 0, 0, 0, 0, loc).AddDate(0, 0, days)
		return fmt.Sprintf("%dW%02d", iy, iw), exp
	case "MONTHLY":
		exp := time.Date(y, m+1, 1, 0, 0, 0, 0, loc)
		return fmt.Sprintf("%04d%02d", y, int(m)), exp
	default: // DAILY
		exp := time.Date(y, m, d+1, 0, 0, 0, 0, loc)
		return fmt.Sprintf("%04d%02d%02d", y, int(m), d), exp
	}
}

// GrantPeriod 给某持卡发当期临时点（幂等：MembershipGrant 唯一键兜底）。
func (s *Service) GrantPeriod(m model.UserMembership, t time.Time) error {
	key, exp := PeriodKeyAndExpiry(m.Cadence, t)
	return s.st.DB.Transaction(func(tx *gorm.DB) error {
		var existing model.MembershipGrant
		err := tx.First(&existing, "user_membership_id = ? AND period_key = ?", m.ID, key).Error
		if err == nil {
			return nil // 本期已发
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if e := bucket.GrantPoints(tx, m.UserID, m.GrantPoints, &exp, bucket.SourceMembership); e != nil {
			return e
		}
		return tx.Create(&model.MembershipGrant{
			UserMembershipID: m.ID, PeriodKey: key, Points: m.GrantPoints, ExpiresAt: exp, CreatedAt: time.Now(),
		}).Error // 唯一键并发兜底：重复插入报错回滚
	})
}

// ActivateInTx 在事务内激活买断会员并发首期临时点（购买回调调用，冗余卡配置）。
func (s *Service) ActivateInTx(tx *gorm.DB, userID string, card model.MembershipCard, now time.Time) error {
	um := model.UserMembership{
		UserID: userID, CardID: card.ID, Cadence: card.Cadence, GrantPoints: card.GrantPoints,
		KbQuotaBytes: card.KbQuotaBytes,
		StartAt:      now, ExpiresAt: now.AddDate(0, 0, card.DurationDays), Status: "active", CreatedAt: now,
	}
	if err := tx.Create(&um).Error; err != nil {
		return err
	}
	// 首期发点（复用 GrantPeriod 的幂等逻辑，但在同一 tx 内联实现避免嵌套事务）
	key, exp := PeriodKeyAndExpiry(um.Cadence, now)
	if e := bucket.GrantPoints(tx, userID, um.GrantPoints, &exp, bucket.SourceMembership); e != nil {
		return e
	}
	return tx.Create(&model.MembershipGrant{
		UserMembershipID: um.ID, PeriodKey: key, Points: um.GrantPoints, ExpiresAt: exp, CreatedAt: now,
	}).Error
}

// 卡 CRUD
func (s *Service) ListCards(enabledOnly bool) ([]model.MembershipCard, error) {
	q := s.st.DB.Model(&model.MembershipCard{}).Order("price_fen asc")
	if enabledOnly {
		q = q.Where("enabled = ?", true)
	}
	var rows []model.MembershipCard
	return rows, q.Find(&rows).Error
}

func (s *Service) GetCard(id uint) (model.MembershipCard, error) {
	var c model.MembershipCard
	return c, s.st.DB.First(&c, "id = ?", id).Error
}

func (s *Service) GetCardTx(tx *gorm.DB, id uint) (model.MembershipCard, error) {
	var c model.MembershipCard
	return c, tx.First(&c, "id = ?", id).Error
}

func (s *Service) UpsertCard(c *model.MembershipCard) error { return s.st.DB.Save(c).Error }

func (s *Service) DeleteCard(id uint) error {
	return s.st.DB.Delete(&model.MembershipCard{}, "id = ?", id).Error
}

// MyMemberships 用户当前有效会员。
func (s *Service) MyMemberships(userID string, now time.Time) ([]model.UserMembership, error) {
	var rows []model.UserMembership
	return rows, s.st.DB.Where("user_id = ? AND status = ? AND expires_at > ?", userID, "active", now).
		Order("expires_at desc").Find(&rows).Error
}

// UserKbQuotaBytes 用户当前有效会员的知识库配额总和（字节）。
func (s *Service) UserKbQuotaBytes(userID string, now time.Time) (int64, error) {
	var total int64
	err := s.st.DB.Model(&model.UserMembership{}).
		Where("user_id = ? AND status = ? AND expires_at > ?", userID, "active", now).
		Select("COALESCE(SUM(kb_quota_bytes),0)").Scan(&total).Error
	return total, err
}
