"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var storage_key_1 = require("./src/storage/storage-key");
var result = (0, storage_key_1.parseStorageKey)('avatars/550e8400-e29b-41d4-a716-446655440000/550e8400-e29b-41d4-a716-446655440000.jpg');
if (result) {
    result.requiresSession = false; // Should be type error now
}
