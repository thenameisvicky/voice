import { englishStrategy } from "./english.js";

const strategies = new Map([
    ["en", englishStrategy],
    ["en-IN", englishStrategy],
]);

export function getStrategy(language = "en") {
    const strategy = strategies.get(language);

    if (!strategy) {
        throw new Error(`Unsupported TTS language: ${language}`);
    }

    return strategy;
}

export async function initializeStrategy(language = "en") {
    const strategy = getStrategy(language);

    await strategy.initialize();

    return strategy;
}