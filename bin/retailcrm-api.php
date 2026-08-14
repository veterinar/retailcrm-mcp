#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * RetailCRM MCP — PHP bridge (protocol v1).
 *
 * Transport for the official retailcrm/api-client-php package (pinned 6.15.32).
 * Reads exactly one JSON request line on stdin and writes exactly one JSON
 * response line on stdout. Fail-closed: any unexpected condition produces
 * {ok:false}; success is only ever reported from a verified API response.
 *
 * Credentials are read from environment variables ONLY. The API key never
 * appears in argv, the JSON payload, stdout, stderr, or error messages.
 *
 * Operations:
 *  - get       → official client, CustomMethods + CustomApiMethod (GET, query params)
 *  - post      → official client, CustomMethods + CustomApiMethod (POST, form params)
 *  - post_raw  → documented compatibility exception for files_upload only:
 *                raw bytes + ?filename= via PHP cURL (the official v6.15.32
 *                FilesUploadRequest drops the filename query param and the
 *                caller's MIME type).
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
ini_set('log_errors', '0');

const PROTOCOL_VERSION    = 1;
const MAX_LINE_BYTES      = 33554432; // 32 MiB request line
const MAX_RESPONSE_BYTES  = 33554432; // 32 MiB API response body
const MAX_ERROR_BODY_BYTES = 8192;
const MAX_STDERR_BYTES    = 8192;
const REQUEST_TIMEOUT     = 15;       // seconds; matches the Node-side whole-call cap

/** Bounded stderr capture (never printed raw; only truncated excerpts on failure). */
$GLOBALS['bridge_stderr'] = '';

set_error_handler(static function (int $severity, string $message): bool {
    $GLOBALS['bridge_stderr'] = substr($GLOBALS['bridge_stderr'] . $message, 0, MAX_STDERR_BYTES);
    return true;
});

function note(string $message): void {
    $GLOBALS['bridge_stderr'] = substr($GLOBALS['bridge_stderr'] . $message, 0, MAX_STDERR_BYTES);
}

/** Respond once with a JSON line and exit. */
function respond(array $payload): void {
    static $responded = false;
    if ($responded) {
        exit(1);
    }
    $responded = true;

    $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false || $json === '') {
        $json = '{"v":1,"ok":false,"status":0,"body":"bridge encoding failure"}';
    }
    fwrite(STDOUT, $json . "\n");
    exit(0);
}

function fail(int $status, string $body): void {
    respond(['v' => PROTOCOL_VERSION, 'ok' => false, 'status' => $status, 'body' => $body]);
}

function failInternal(string $message): void {
    $excerpt = trim($GLOBALS['bridge_stderr']);
    if ($excerpt !== '') {
        $message .= ' [' . substr($excerpt, 0, 256) . ']';
    }
    fail(0, $message);
}

/** Catch fatal errors that bypass exceptions so the caller never sees empty success. */
register_shutdown_function(static function (): void {
    $last = error_get_last();
    if ($last !== null && in_array($last['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        failInternal('bridge fatal error');
    }
});

/**
 * Validate the path and return the route with the leading slash stripped
 * (CustomApiMethod routes are relative; BaseUrlAwareTrait prepends /api/v5).
 * Forbids absolute URLs, traversal, CR/LF/NUL, and overlong input.
 */
function validatePath(string $path): string {
    if ($path === '' || strlen($path) > 2048) {
        fail(0, 'invalid path');
    }
    if (strpbrk($path, "\r\n\0") !== false) {
        fail(0, 'invalid path: control characters are forbidden');
    }
    if (preg_match('~^[a-z][a-z0-9+.\-]*://~i', $path) === 1) {
        fail(0, 'invalid path: absolute URLs are forbidden');
    }
    if (strpos($path, '..') !== false) {
        fail(0, 'invalid path: traversal is forbidden');
    }
    $route = ltrim($path, '/');
    if ($route === '') {
        fail(0, 'invalid path');
    }
    return $route;
}

/** Normalized RetailCRM origin (https, no trailing slash, no /api/vN suffix). */
function apiOrigin(): string {
    $domain = getenv('RETAILCRM_DOMAIN') ?: getenv('RETAILCRM_URL') ?: '';
    $domain = trim((string) $domain);
    if ($domain === '') {
        fail(0, 'RETAILCRM_DOMAIN is not set');
    }
    $domain = (string) preg_replace('~^https?://~i', '', $domain);
    $domain = rtrim($domain, '/');
    $domain = (string) preg_replace('~/api/v\d+$~i', '', $domain);
    // Strict hostname: exactly one label-structured host, no userinfo, path,
    // query, fragment, whitespace, or control characters.
    if (preg_match('~^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$~iD', $domain) !== 1) {
        fail(0, 'invalid RETAILCRM_DOMAIN: a plain hostname is required (e.g. yourstore.retailcrm.ru)');
    }
    return 'https://' . strtolower($domain);
}

function apiKey(): string {
    $key = trim((string) getenv('RETAILCRM_API_KEY'));
    if ($key === '') {
        fail(0, 'RETAILCRM_API_KEY is not set');
    }
    return $key;
}

/** Redact the API key from any string that might reach an error body. */
function redact(string $text): string {
    $key = trim((string) getenv('RETAILCRM_API_KEY'));
    if ($key !== '') {
        $text = str_replace($key, '[redacted]', $text);
    }
    return substr($text, 0, MAX_ERROR_BODY_BYTES);
}

/** Flat string parameters only — exactly what the tool layer produces. */
function normalizeParams($params): array {
    if ($params === null) {
        return [];
    }
    if (!is_array($params)) {
        fail(0, 'invalid params');
    }
    $flat = [];
    foreach ($params as $name => $value) {
        if (!is_string($name) || (!is_string($value) && !is_int($value) && !is_float($value) && !is_bool($value))) {
            fail(0, 'invalid params: flat string values required');
        }
        $flat[$name] = (string) $value;
    }
    return $flat;
}

function requireAutoloader(): void {
    $autoloader = __DIR__ . '/../vendor/autoload.php';
    if (!is_file($autoloader)) {
        fail(0, 'vendor/autoload.php not found — run composer install');
    }
    require_once $autoloader;
}

/**
 * GET / form POST through the official client using CustomMethods +
 * CustomApiMethod, with the route stripped of its leading slash and the flat
 * string parameters preserved exactly.
 */
function officialRequest(string $method, string $route, array $params): array {
    requireAutoloader();

    $client = \RetailCrm\Api\Factory\SimpleClientFactory::createClient(apiOrigin(), apiKey());
    $client->customMethods->register(
        'mcp',
        new \RetailCrm\Api\Component\CustomApiMethod($method, $route)
    );

    try {
        $data = $client->customMethods->call('mcp', $params);
    } catch (\RetailCrm\Api\Interfaces\ApiExceptionInterface $e) {
        $errorResponse = $e->getErrorResponse();
        fail(
            $e->getStatusCode(),
            (string) json_encode(
                [
                    'success'  => false,
                    'errorMsg' => $errorResponse->errorMsg ?? $e->getMessage(),
                    'errors'   => $errorResponse->errors ?? [],
                ],
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
            )
        );
    }

    return is_array($data) ? $data : ['success' => true];
}

/**
 * files_upload compatibility exception: raw bytes + ?filename= via PHP cURL
 * against the same normalized origin, X-API-KEY header, 15-second timeout,
 * and bounded error handling. Only the files/upload route is permitted.
 */
function rawUpload(string $route, string $bodyBytes, string $contentType): array {
    $queryPos = strpos($route, '?');
    $pathPart = $queryPos === false ? $route : substr($route, 0, $queryPos);
    if ($pathPart !== 'files/upload') {
        fail(0, 'unsupported raw operation: only files/upload is allowed');
    }

    $url = apiOrigin() . '/api/v5/' . $route; // $route carries the ?filename= query

    $headers = [
        'Content-Type: ' . $contentType,
        'Accept: application/json',
        'X-API-KEY: ' . apiKey(),
    ];

    $handle = curl_init($url);
    if ($handle === false) {
        failInternal('bridge error: curl init failed');
    }
    curl_setopt_array($handle, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $bodyBytes,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => REQUEST_TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER     => $headers,
    ]);

    $responseBody = curl_exec($handle);
    if ($responseBody === false) {
        $errno = curl_errno($handle);
        curl_close($handle);
        failInternal('bridge error: files_upload failed (curl errno ' . $errno . ')');
    }
    $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    curl_close($handle);

    $responseBody = (string) $responseBody;
    if (strlen($responseBody) > MAX_RESPONSE_BYTES) {
        failInternal('bridge error: files_upload response too large');
    }
    if ($status >= 400) {
        fail($status, redact($responseBody));
    }

    // Fail closed on 2xx: an empty or non-JSON success body means the call did
    // not produce a verified RetailCRM response — report an error, not success.
    $decoded = json_decode($responseBody, true);
    if (trim($responseBody) === '' || !is_array($decoded)) {
        failInternal('bridge error: files_upload returned an empty or non-JSON response');
    }
    return $decoded;
}

(function (): void {
    $line = fgets(STDIN);
    if ($line === false || trim($line) === '') {
        fail(0, 'empty bridge request');
    }
    if (strlen($line) > MAX_LINE_BYTES) {
        fail(0, 'bridge request too large');
    }

    $request = json_decode(trim($line), true);
    if (!is_array($request)) {
        fail(0, 'malformed bridge request');
    }
    if (($request['v'] ?? null) !== PROTOCOL_VERSION) {
        fail(0, 'unsupported bridge protocol version');
    }
    $op = $request['op'] ?? null;
    if (!is_string($op) || !in_array($op, ['get', 'post', 'post_raw'], true)) {
        fail(0, 'unsupported bridge operation');
    }
    if (!isset($request['path']) || !is_string($request['path'])) {
        fail(0, 'invalid path');
    }

    $route = validatePath($request['path']);

    if ($op === 'get' || $op === 'post') {
        if (strpos($route, '?') !== false) {
            fail(0, 'query strings are not allowed for this operation; use params');
        }
        $params = normalizeParams($request['params'] ?? null);
        $method = $op === 'get'
            ? \RetailCrm\Api\Enum\RequestMethod::GET
            : \RetailCrm\Api\Enum\RequestMethod::POST;
        respond([
            'v'      => PROTOCOL_VERSION,
            'ok'     => true,
            'status' => 200,
            'data'   => officialRequest($method, $route, $params),
        ]);
    }

    // post_raw (files_upload exception)
    $bodyBase64 = $request['body_base64'] ?? null;
    if (!is_string($bodyBase64) || $bodyBase64 === '') {
        fail(0, 'invalid body_base64');
    }
    $bodyBytes = base64_decode($bodyBase64, true);
    if ($bodyBytes === false || strlen($bodyBytes) > MAX_RESPONSE_BYTES) {
        fail(0, 'invalid body_base64');
    }
    $contentType = $request['content_type'] ?? 'application/octet-stream';
    if (!is_string($contentType) || $contentType === '' || strlen($contentType) > 255
        || strpbrk($contentType, "\r\n\0") !== false
    ) {
        fail(0, 'invalid content_type');
    }

    respond([
        'v'      => PROTOCOL_VERSION,
        'ok'     => true,
        'status' => 200,
        'data'   => rawUpload($route, $bodyBytes, $contentType),
    ]);
})();
