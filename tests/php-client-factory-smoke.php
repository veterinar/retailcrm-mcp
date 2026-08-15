<?php
declare(strict_types=1);

/**
 * RetailCRM MCP — PHP client factory smoke test (no network).
 *
 * Proves that the locked PRODUCTION dependency graph contains concrete
 * PSR-7/PSR-17 and PSR-18 implementations, so that the official
 * RetailCrm\Api\Factory\SimpleClientFactory::createClient() can resolve its
 * HTTP stack via php-http discovery. On the unfixed dependency graph this
 * script fails with Http\Discovery\Exception\NotFoundException ("No PSR-17
 * url factory found") and exits nonzero.
 *
 * Client construction performs dependency discovery only; it never performs
 * a network request. Dummy non-secret values are used and never printed.
 */

$autoloader = __DIR__ . '/../vendor/autoload.php';
if (!is_file($autoloader)) {
    fwrite(STDERR, "FAIL: vendor/autoload.php not found — run composer install\n");
    exit(1);
}
require_once $autoloader;

if (!class_exists(\RetailCrm\Api\Factory\SimpleClientFactory::class)) {
    fwrite(STDERR, "FAIL: retailcrm/api-client-php is not autoloadable\n");
    exit(1);
}

try {
    $client = \RetailCrm\Api\Factory\SimpleClientFactory::createClient(
        'https://smoke-test.invalid',
        'dummy-key'
    );
} catch (\Throwable $e) {
    // Discovery failures (missing PSR-7/17/18 implementation) land here.
    fwrite(STDERR, 'FAIL: client factory threw ' . get_class($e) . ': ' . $e->getMessage() . "\n");
    exit(1);
}

if (!$client instanceof \RetailCrm\Api\Client) {
    fwrite(STDERR, 'FAIL: factory returned ' . get_class($client) . ', expected RetailCrm\Api\Client' . "\n");
    exit(1);
}

echo "OK: SimpleClientFactory resolved a concrete PSR-7/PSR-17/PSR-18 stack\n";
exit(0);
