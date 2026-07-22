-- Flexible-date watches (feature C). A watch's [start_date, end_date] becomes a
-- SEARCH WINDOW, and flex_nights is the length of stay to match anywhere inside it:
-- "any flex_nights consecutive nights within [start_date, end_date)". flex_days adds
-- a day constraint. Both NULL = a legacy fixed whole-stay watch (unchanged behavior).
ALTER TABLE watches ADD COLUMN IF NOT EXISTS flex_nights INTEGER; -- run length; NULL = fixed whole-stay
ALTER TABLE watches ADD COLUMN IF NOT EXISTS flex_days TEXT;      -- 'weekend' (Sat night) | NULL = any
