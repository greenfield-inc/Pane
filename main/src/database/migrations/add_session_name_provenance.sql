-- Track names explicitly chosen by the user so automatic naming cannot overwrite them.
ALTER TABLE sessions ADD COLUMN name_manually_set BOOLEAN DEFAULT 0;
