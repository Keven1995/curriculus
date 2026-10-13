ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS pix_qr_code text,
  ADD COLUMN IF NOT EXISTS pix_qr_code_base64 text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'orders_pix_charge_data_check'
       AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_pix_charge_data_check
      CHECK (
        (provider_payment_id IS NULL AND pix_qr_code IS NULL AND pix_qr_code_base64 IS NULL)
        OR
        (
          provider_payment_id IS NOT NULL
          AND (
            (pix_qr_code IS NULL AND pix_qr_code_base64 IS NULL)
            OR (pix_qr_code IS NOT NULL AND pix_qr_code_base64 IS NOT NULL)
          )
        )
      );
  END IF;
END
$$;
