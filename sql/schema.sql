
DROP TABLE IF EXISTS Email;


CREATE TABLE Email (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject VARCHAR(255),
    "from" VARCHAR(255),
    "to" VARCHAR(255),
    "forwarded_to" VARCHAR(255),
    headers TEXT,
    html TEXT,
    text TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);


DROP TABLE IF EXISTS Attachment;


CREATE TABLE Attachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emailId INTEGER,
    filename VARCHAR(255),
    disposition VARCHAR(50),
    mimeType VARCHAR(100),
    size INTEGER,
    FOREIGN KEY (emailId) REFERENCES Email(id)
);


DROP TABLE IF EXISTS AccessToken;


CREATE TABLE AccessToken (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(80) NOT NULL,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    token_prefix VARCHAR(16) NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    lastUsedAt DATETIME,
    revokedAt DATETIME
);


CREATE INDEX idx_access_token_hash ON AccessToken(token_hash);
