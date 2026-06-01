-- 섹션(담당자 매칭용 분류) 테이블
-- Supabase SQL Editor에서 1회 실행하세요.
CREATE TABLE IF NOT EXISTS sections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR NOT NULL,
  description      TEXT,                 -- 분류 정확도를 위한 섹션 설명
  curator_slack_id VARCHAR,             -- 담당자 Slack user ID (예: U12345). 비어있으면 태그 안 함
  curator_name     VARCHAR,             -- 어드민 표시용 이름 (선택)
  is_deleted       BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMP DEFAULT now(),
  updated_at       TIMESTAMP DEFAULT now()
);
