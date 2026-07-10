package vip

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"
	"yc-billing/internal/model"
)

func TestEnsureDefaultLevelsSeedsTenLevels(t *testing.T) {
	db := openTestDB(t)
	svc := New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	levels, err := svc.ListLevels(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(levels) != 10 {
		t.Fatalf("levels=%d, want 10", len(levels))
	}
	if levels[0].Name != "普通会员" || levels[0].ThresholdPoints != 0 || levels[0].DiscountBps != 10000 {
		t.Fatalf("bad default level: %+v", levels[0])
	}
	if levels[1].Name != "银卡会员" || levels[1].ThresholdRMBFen != 10000 || levels[1].ThresholdPoints != 10000 {
		t.Fatalf("bad silver level: %+v", levels[1])
	}
	if levels[2].Name != "金卡会员" || levels[2].ThresholdRMBFen != 30000 || levels[2].ThresholdPoints != 30000 {
		t.Fatalf("bad gold level: %+v", levels[2])
	}
}

func TestEnsureDefaultLevelsConcurrentSeedCreatesOnlyTenLevels(t *testing.T) {
	db := openTestDB(t)
	svc := New(db)
	start := make(chan struct{})
	errCh := make(chan error, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if err := svc.EnsureDefaultLevels(100); err != nil {
				errCh <- err
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	levels, err := svc.ListLevels(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(levels) != 10 {
		t.Fatalf("levels=%d, want 10", len(levels))
	}
	var defaultCount int64
	if err := db.Model(&model.VipLevel{}).Where("threshold_points = ? AND enabled = ?", 0, true).Count(&defaultCount).Error; err != nil {
		t.Fatal(err)
	}
	if defaultCount != 1 {
		t.Fatalf("defaultCount=%d, want 1", defaultCount)
	}
	names := make(map[string]int)
	for _, level := range levels {
		names[level.Name]++
	}
	for name, count := range names {
		if count != 1 {
			t.Fatal(fmt.Errorf("level %s duplicated %d times", name, count))
		}
	}
}

func TestUpsertLevelFreezesThresholdWithRechargeRatio(t *testing.T) {
	db := openTestDB(t)
	svc := New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	// sortOrder 15 落在默认「普通会员(阈值0)」与「银卡会员(阈值10000)」之间，
	// 两次冻结阈值(4000×200/100=8000、4000×50/100=2000)都需 < 10000 才满足按 sortOrder 递增的等级不变量。
	level, err := svc.UpsertLevel(UpsertLevelInput{
		Name: "测试会员", SortOrder: 15, ThresholdRMBFen: 4000,
		RechargeRatio: 200, DiscountBps: 8800, Enabled: true, UpgradeEnabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if level.ThresholdPoints != 8000 || level.SavedRechargeRatio != 200 {
		t.Fatalf("frozen threshold mismatch: %+v", level)
	}
	level, err = svc.UpsertLevel(UpsertLevelInput{
		ID: level.ID, Name: "测试会员", SortOrder: 15, ThresholdRMBFen: 4000,
		RechargeRatio: 50, DiscountBps: 8800, Enabled: true, UpgradeEnabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if level.ThresholdPoints != 2000 || level.SavedRechargeRatio != 50 {
		t.Fatalf("edited threshold should refreeze: %+v", level)
	}
}

func TestDeleteLevelRejectsOccupiedLevel(t *testing.T) {
	db := openTestDB(t)
	svc := New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	levels, err := svc.ListLevels(false)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.UserVipState{
		UserID: "u1", VipLevelID: levels[1].ID, GrowthPoints: 10000,
		UpgradedAt: time.Now(), CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteLevel(levels[1].ID); err != ErrLevelOccupied {
		t.Fatalf("err=%v, want ErrLevelOccupied", err)
	}
}

func TestDeleteLevelRejectsOnlyDefaultLevel(t *testing.T) {
	db := openTestDB(t)
	svc := New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	levels, err := svc.ListLevels(false)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteLevel(levels[0].ID); err != ErrInvalidLevel {
		t.Fatalf("err=%v, want ErrInvalidLevel", err)
	}
	var count int64
	if err := db.Model(&model.VipLevel{}).Where("id = ?", levels[0].ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("default level deleted, count=%d", count)
	}
}

func TestDeleteLevelRejectsMissingLevel(t *testing.T) {
	db := openTestDB(t)
	svc := New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteLevel(999999); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("err=%v, want gorm.ErrRecordNotFound", err)
	}
}
