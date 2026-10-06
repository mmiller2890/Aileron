-- Who said a captured line ("Speaker 1" … "Speaker 4"); NULL for typed
-- messages, answers, and lines the live diarizer could not attribute.
ALTER TABLE messages ADD COLUMN speaker TEXT;
