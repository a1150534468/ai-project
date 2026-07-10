-- CreateTable
CREATE TABLE "MetricsDaily" (
    "date" DATE NOT NULL,
    "registered" INTEGER NOT NULL DEFAULT 0,
    "dau" INTEGER NOT NULL DEFAULT 0,
    "wau" INTEGER NOT NULL DEFAULT 0,
    "mau" INTEGER NOT NULL DEFAULT 0,
    "newPayingUsers" INTEGER NOT NULL DEFAULT 0,
    "payingTotal" INTEGER NOT NULL DEFAULT 0,
    "revenueFen" INTEGER NOT NULL DEFAULT 0,
    "grantedPoints" INTEGER NOT NULL DEFAULT 0,
    "consumedPoints" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetricsDaily_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "CohortDaily" (
    "cohortDate" DATE NOT NULL,
    "dayOffset" INTEGER NOT NULL,
    "cohortSize" INTEGER NOT NULL DEFAULT 0,
    "retained" INTEGER NOT NULL DEFAULT 0,
    "cumRevenueFen" INTEGER NOT NULL DEFAULT 0,
    "cumPayers" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CohortDaily_pkey" PRIMARY KEY ("cohortDate","dayOffset")
);
