ALTER TABLE ownership_proofs DROP CONSTRAINT ownership_proofs_anchor_complete;
ALTER TABLE ownership_proofs ADD CONSTRAINT ownership_proofs_anchor_complete
  CHECK (anchored_at IS NULL OR anchor_txid IS NOT NULL);
