-- qa_items에 섹션 분류용 FK 컬럼 추가 (Part 2 — 섹션 스코프 답변 + 셀프-그로잉)
-- Supabase SQL Editor에서 1회 실행하세요. (또는 `pnpm db:migrate`) 멱등(idempotent).

-- 1) nullable 컬럼 추가
ALTER TABLE qa_items
  ADD COLUMN IF NOT EXISTS section_id UUID;

-- 2) FK 제약 (ADD CONSTRAINT는 IF NOT EXISTS 미지원 → pg_constraint 가드로 멱등 처리)
--    섹션이 하드 삭제돼도 qa_item은 남고 section_id만 NULL로 → 전역 KB 동작으로 자연 폴백
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'qa_items_section_id_fkey'
  ) THEN
    ALTER TABLE qa_items
      ADD CONSTRAINT qa_items_section_id_fkey
      FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3) 섹션별 조회 성능 (모든 쿼리가 is_deleted=FALSE를 함께 거름)
CREATE INDEX IF NOT EXISTS qa_items_section_id_idx
  ON qa_items (section_id) WHERE is_deleted = FALSE;
