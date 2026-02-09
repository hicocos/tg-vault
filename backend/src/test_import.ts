
console.log('Starting import test...');
try {
    const telegram = await import('telegram');
    console.log('Telegram module imported successfully.');
    console.log('Classes available:', Object.keys(telegram));
} catch (error) {
    console.error('Import failed:', error);
}
console.log('Import test finished.');
