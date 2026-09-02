CREATE OR REPLACE FUNCTION protect_ownership_proof()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ownership proofs cannot be deleted';
  END IF;

  IF OLD.anchor_txid IS NOT NULL AND (
    NEW.content IS DISTINCT FROM OLD.content
    OR NEW.content_size_bytes IS DISTINCT FROM OLD.content_size_bytes
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.anchor_txid IS DISTINCT FROM OLD.anchor_txid
    OR NEW.anchored_at IS DISTINCT FROM OLD.anchored_at
    OR NEW.note IS DISTINCT FROM OLD.note
  ) THEN
    RAISE EXCEPTION 'anchored ownership proof is immutable';
  END IF;

  RETURN NEW;
END;
$$;
