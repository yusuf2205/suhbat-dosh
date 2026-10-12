-- compact loudness profile of a voice message (base64url bytes), drawn as the waveform in the chat
ALTER TABLE messages ADD COLUMN waveform TEXT;
