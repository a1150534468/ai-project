package vip

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"ai-assistant-billing/internal/model"
)

func TestAddGrowthUpgradesOnlyUpAndIsIdempotent(t *testing.T) {
	db := openTestDB(t)
	svc := New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	before, after, err := svc.AddGrowthInTx(db, AddGrowthInput{
		OperationID: "usage:1", UserID: "u1", SourceType: "usage", GrowthPoints: 10000,
		RelatedUsageOperationID: "usage:1", Note: "paid bucket consumption",
		OccurredAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if before.LevelName != "普通会员" || after.LevelName != "银卡会员" || after.GrowthPoints != 10000 {
		t.Fatalf("unexpected upgrade: before=%+v after=%+v", before, after)
	}
	_, afterAgain, err := svc.AddGrowthInTx(db, AddGrowthInput{
		OperationID: "usage:1", UserID: "u1", SourceType: "usage", GrowthPoints: 10000,
		RelatedUsageOperationID: "usage:1", Note: "duplicate callback",
		OccurredAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if afterAgain.GrowthPoints != 10000 || afterAgain.LevelName != "银卡会员" {
		t.Fatalf("duplicate growth changed state: %+v", afterAgain)
	}
}

func TestAddGrowthConcurrentSameOperationIDIsIdempotent(t *testing.T) {
	db := openTestDB(t)
	svc := New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	input := AddGrowthInput{
		OperationID:             "usage:concurrent-op",
		UserID:                  "u-op",
		SourceType:              "usage",
		GrowthPoints:            10000,
		RelatedUsageOperationID: "usage:concurrent-op",
		OccurredAt:              time.Now(),
	}
	start := make(chan struct{})
	errCh := make(chan error, 2)
	var summaries [2]Summary
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		index := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, after, err := svc.AddGrowthInTx(db, input)
			if err != nil {
				errCh <- err
				return
			}
			summaries[index] = after
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
	for i := range summaries {
		if summaries[i].GrowthPoints != 10000 || summaries[i].LevelName != "银卡会员" {
			t.Fatalf("summary[%d]=%+v", i, summaries[i])
		}
	}
	var ledgerCount int64
	if err := db.Model(&model.VipGrowthLedger{}).Where("operation_id = ?", input.OperationID).Count(&ledgerCount).Error; err != nil {
		t.Fatal(err)
	}
	if ledgerCount != 1 {
		t.Fatalf("ledgerCount=%d, want 1", ledgerCount)
	}
	var state model.UserVipState
	if err := db.First(&state, "user_id = ?", input.UserID).Error; err != nil {
		t.Fatal(err)
	}
	if state.GrowthPoints != 10000 {
		t.Fatalf("growth=%d, want 10000", state.GrowthPoints)
	}
}

func TestAddGrowthRejectsInvalidInput(t *testing.T) {
	db := openTestDB(t)
	svc := New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	cases := []AddGrowthInput{
		{OperationID: "", UserID: "u1", SourceType: "usage", GrowthPoints: 1},
		{OperationID: "op1", UserID: "", SourceType: "usage", GrowthPoints: 1},
		{OperationID: "op1", UserID: "u1", SourceType: "", GrowthPoints: 1},
		{OperationID: "  ", UserID: "u1", SourceType: "usage", GrowthPoints: 1},
		{OperationID: "op1", UserID: "  ", SourceType: "usage", GrowthPoints: 1},
		{OperationID: "op1", UserID: "u1", SourceType: "   ", GrowthPoints: 1},
		{OperationID: "op1", UserID: "u1", SourceType: "usage", GrowthPoints: -1},
	}
	for i, input := range cases {
		_, _, err := svc.AddGrowthInTx(db, input)
		if !errors.Is(err, ErrInvalidGrowthInput) {
			t.Fatalf("case %d err=%v, want ErrInvalidGrowthInput", i, err)
		}
	}
	var stateCount int64
	if err := db.Model(&model.UserVipState{}).Count(&stateCount).Error; err != nil {
		t.Fatal(err)
	}
	if stateCount != 0 {
		t.Fatalf("stateCount=%d, want 0", stateCount)
	}
	var ledgerCount int64
	if err := db.Model(&model.VipGrowthLedger{}).Count(&ledgerCount).Error; err != nil {
		t.Fatal(err)
	}
	if ledgerCount != 0 {
		t.Fatalf("ledgerCount=%d, want 0", ledgerCount)
	}
}

func TestAddGrowthSkipsDisabledAndUpgradeDisabledLevels(t *testing.T) {
	db := openTestDB(t)
	svc := New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertLevel(UpsertLevelInput{
		Name: "升级关闭等级", SortOrder: 15, ThresholdRMBFen: 50,
		RechargeRatio: 100, DiscountBps: 8800, Enabled: true, UpgradeEnabled: false,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertLevel(UpsertLevelInput{
		Name: "停用等级", SortOrder: 16, ThresholdRMBFen: 60,
		RechargeRatio: 100, DiscountBps: 8700, Enabled: false, UpgradeEnabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	before, after, err := svc.AddGrowthInTx(db, AddGrowthInput{
		OperationID: "usage:skip-levels", UserID: "u-skip", SourceType: "usage", GrowthPoints: 7000,
		RelatedUsageOperationID: "usage:skip-levels", OccurredAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if before.LevelName != "普通会员" || after.LevelName != "普通会员" {
		t.Fatalf("unexpected level transition: before=%+v after=%+v", before, after)
	}
	if after.GrowthPoints != 7000 {
		t.Fatalf("after growth=%d, want 7000", after.GrowthPoints)
	}
}

func TestSummaryConcurrentInitializationCreatesOneState(t *testing.T) {
	db := openTestDB(t)
	svc := New(db)
	if err := svc.EnsureDefaultLevels(100); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	errCh := make(chan error, 16)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			summary, err := svc.Summary("u-concurrent")
			if err != nil {
				errCh <- err
				return
			}
			if summary.LevelName != "普通会员" {
				errCh <- fmt.Errorf("level=%s, want 普通会员", summary.LevelName)
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
	var count int64
	if err := db.Model(&model.UserVipState{}).Where("user_id = ?", "u-concurrent").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("state rows=%d, want 1", count)
	}
}
