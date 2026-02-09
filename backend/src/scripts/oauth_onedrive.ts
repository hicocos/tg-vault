
import http from 'http';
import axios from 'axios';
import { URL } from 'url';

// ============================================
// OneDrive OAuth 授权工具
// 用于获取 AccessToken 和 RefreshToken
// ============================================

const CLIENT_ID = 'REMOVED_ONEDRIVE_CLIENT_ID';
const TENANT_ID = '79e54b9b-9f89-4c66-be4d-6f5bb457703b'; // 您的租户ID
const REDIRECT_URI = 'http://localhost:53682/';
const SCOPE = 'Files.ReadWrite.All offline_access';

const AUTH_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?` +
    `client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&response_mode=query`;

console.log('==========================================');
console.log('OneDrive 国际版授权工具');
console.log('==========================================\n');

console.log('请在浏览器中打开以下链接进行授权:\n');
console.log(AUTH_URL);
console.log('\n等待授权回调...\n');

// 启动本地服务器接收回调
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '', `http://localhost:53682`);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
        console.error('授权失败:', error, url.searchParams.get('error_description'));
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>授权失败</h1><p>${error}</p>`);
        server.close();
        return;
    }

    if (code) {
        console.log('收到授权码，正在换取令牌...\n');

        try {
            // 用授权码换取令牌
            const tokenParams = new URLSearchParams();
            tokenParams.append('client_id', CLIENT_ID);
            tokenParams.append('scope', SCOPE);
            tokenParams.append('code', code);
            tokenParams.append('redirect_uri', REDIRECT_URI);
            tokenParams.append('grant_type', 'authorization_code');

            const tokenRes = await axios.post(
                `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
                tokenParams.toString(),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
            );

            const { access_token, refresh_token, expires_in } = tokenRes.data;

            console.log('==========================================');
            console.log('✓ 授权成功！');
            console.log('==========================================\n');
            console.log(`Access Token (有效期 ${expires_in} 秒):`);
            console.log(access_token.substring(0, 100) + '...\n');
            console.log('Refresh Token (用于保存到数据库):');
            console.log(refresh_token);
            console.log('\n==========================================');
            console.log('请复制上面的 Refresh Token');
            console.log('==========================================');

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <html>
                <head><title>授权成功</title></head>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                    <h1 style="color: green;">✓ 授权成功！</h1>
                    <p>请返回终端查看令牌信息。</p>
                    <p>您可以关闭此窗口。</p>
                </body>
                </html>
            `);

        } catch (err: any) {
            console.error('换取令牌失败:', err.response?.data || err.message);
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h1>换取令牌失败</h1><pre>${JSON.stringify(err.response?.data, null, 2)}</pre>`);
        }

        server.close();
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(53682, () => {
    console.log('本地服务器已启动在 http://localhost:53682');
    console.log('等待浏览器授权回调...\n');
});
