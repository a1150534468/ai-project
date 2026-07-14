package pointsdetail

import (
	"time"

	"gorm.io/gorm"
	"ai-assistant-billing/internal/membership"
	"ai-assistant-billing/internal/model"
)

type Period struct {
	Granted   int64
	Remaining int64
	Used      int64
	ExpiresAt time.Time
	Has       bool
}

type Membership struct {
	CardName  string
	Cadence   string
	ExpiresAt time.Time
	Has       bool
}

type Detail struct {
	TotalPoints      int64
	PermanentPoints  int64
	MembershipPoints int64
	Period           Period
	Membership       Membership
}

// Compute 只读聚合：永久(不带过期)/临时(带过期)算力点 + 当前会员本期临时点。
// 分区口径保证 永久 + 临时 = 合计；used = 本期发放 - 本期临时桶剩余（临时点优先扣费，语义正确）。
func Compute(db *gorm.DB, userID string, now time.Time) (Detail, error) {
	var d Detail
	if err := db.Model(&model.PointBucket{}).
		Where("user_id = ? AND remaining > 0 AND expires_at IS NULL", userID).
		Select("COALESCE(SUM(remaining),0)").Scan(&d.PermanentPoints).Error; err != nil {
		return d, err
	}
	if err := db.Model(&model.PointBucket{}).
		Where("user_id = ? AND remaining > 0 AND expires_at > ?", userID, now).
		Select("COALESCE(SUM(remaining),0)").Scan(&d.MembershipPoints).Error; err != nil {
		return d, err
	}
	d.TotalPoints = d.PermanentPoints + d.MembershipPoints

	var mems []model.UserMembership
	if err := db.Where("user_id = ? AND status = ? AND expires_at > ?", userID, "active", now).
		Order("expires_at desc").Find(&mems).Error; err != nil {
		return d, err
	}
	if len(mems) == 0 {
		return d, nil
	}

	latest := mems[0]
	name := ""
	var card model.MembershipCard
	if err := db.First(&card, "id = ?", latest.CardID).Error; err == nil {
		name = card.Name
	}
	d.Membership = Membership{CardName: name, Cadence: latest.Cadence, ExpiresAt: latest.ExpiresAt, Has: true}

	// 遍历有效持卡，累加本期发放额、取最近到期。
	// 剩余不在此处按桶求和：所有存活临时桶都属于当前周期（上一周期桶已在期末过期），
	// 故本期剩余 = 全部存活临时点(MembershipPoints)，避免多卡同 cadence 时按桶重复统计。
	for _, m := range mems {
		key, exp := membership.PeriodKeyAndExpiry(m.Cadence, now)
		var g model.MembershipGrant
		if err := db.First(&g, "user_membership_id = ? AND period_key = ?", m.ID, key).Error; err != nil {
			continue // 本期未发/查不到，跳过
		}
		d.Period.Has = true
		d.Period.Granted += g.Points
		if d.Period.ExpiresAt.IsZero() || exp.Before(d.Period.ExpiresAt) {
			d.Period.ExpiresAt = exp // 取最近到期
		}
	}
	if d.Period.Has {
		d.Period.Remaining = d.MembershipPoints
		d.Period.Used = d.Period.Granted - d.Period.Remaining
		if d.Period.Used < 0 {
			d.Period.Used = 0
		}
	}
	return d, nil
}
