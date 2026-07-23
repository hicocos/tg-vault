import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');
const productionTemplate = fs.readFileSync(new URL('../../../deploy/nginx-site.conf', import.meta.url), 'utf8');
const initTemplate = fs.readFileSync(new URL('../../../deploy/nginx-site-init.conf', import.meta.url), 'utf8');

test('API media proxy preserves Range and disables response buffering', () => {
    assert.match(source, /location \^~ \/api/);
    assert.match(source, /proxy_set_header Range \$http_range;/);
    assert.match(source, /proxy_set_header If-Range \$http_if_range;/);
    assert.match(source, /proxy_buffering off;/);
});

test('host Nginx deployment templates preserve Range and disable buffering', () => {
    for (const template of [productionTemplate, initTemplate]) {
        assert.match(template, /proxy_set_header Range \$http_range;/);
        assert.match(template, /proxy_set_header If-Range \$http_if_range;/);
        assert.match(template, /proxy_buffering off;/);
        assert.match(template, /proxy_request_buffering off;/);
    }
});
