-- Is there a thumbnail next to the file (NULL: not known yet, looked up once on the disk), and a tiny blurred picture shown before anything loads.
ALTER TABLE files ADD COLUMN has_thumb INTEGER;
ALTER TABLE files ADD COLUMN tiny TEXT;
