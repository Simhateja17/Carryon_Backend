-- Keep phone-backed OTP identity resolution deterministic even when older
-- records used local Malaysian phone formats instead of E.164.

CREATE UNIQUE INDEX IF NOT EXISTS "User_normalizedPhone_key"
ON public."User" (
  (
    CASE
      WHEN regexp_replace(phone, '[\s().-]', '', 'g') ~ '^\+[0-9]{8,15}$'
        THEN regexp_replace(phone, '[\s().-]', '', 'g')
      WHEN regexp_replace(phone, '\D', '', 'g') ~ '^0[0-9]{7,14}$'
        THEN '+60' || substring(regexp_replace(phone, '\D', '', 'g') from 2)
      WHEN regexp_replace(phone, '\D', '', 'g') ~ '^60[0-9]{6,13}$'
        THEN '+' || regexp_replace(phone, '\D', '', 'g')
      ELSE NULL
    END
  )
)
WHERE nullif(trim(phone), '') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Driver_normalizedPhone_key"
ON public."Driver" (
  (
    CASE
      WHEN regexp_replace(phone, '[\s().-]', '', 'g') ~ '^\+[0-9]{8,15}$'
        THEN regexp_replace(phone, '[\s().-]', '', 'g')
      WHEN regexp_replace(phone, '\D', '', 'g') ~ '^0[0-9]{7,14}$'
        THEN '+60' || substring(regexp_replace(phone, '\D', '', 'g') from 2)
      WHEN regexp_replace(phone, '\D', '', 'g') ~ '^60[0-9]{6,13}$'
        THEN '+' || regexp_replace(phone, '\D', '', 'g')
      ELSE NULL
    END
  )
)
WHERE nullif(trim(phone), '') IS NOT NULL;
