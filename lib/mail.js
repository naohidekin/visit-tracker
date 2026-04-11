'use strict';
// メール送信モジュール（パスワードリセットメール）

const nodemailer = require('nodemailer');

let mailTransport = null;

function createMailTransport() {
  if (!process.env.MAIL_FROM || !process.env.MAIL_APP_PASSWORD) {
    console.warn('⚠️ MAIL_FROM / MAIL_APP_PASSWORD が未設定です。パスワードリセットメールは送信できません。');
    return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.MAIL_FROM,
      pass: process.env.MAIL_APP_PASSWORD,
    },
  });
}

async function sendResetEmail(toEmail, staffName, resetUrl, maxRetries = 3) {
  if (!mailTransport) {
    console.error('❌ メールトランスポートが未初期化です');
    return false;
  }
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await mailTransport.sendMail({
      from: `"にこっとweb App" <${process.env.MAIL_FROM}>`,
      to: toEmail,
      subject: '【にこっとweb App】パスワードリセット',
      text: `${staffName}さん\n\nパスワードリセットのリクエストを受け付けました。\n以下のリンクをクリックして新しいパスワードを設定してください。\n\n${resetUrl}\n\n※ このリンクは30分間有効です。\n※ 心当たりのない場合は、このメールを無視してください。\n\n--\nにこっと訪問看護ステーション`,
      html: `
        <div style="font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;max-width:480px;margin:0 auto;padding:20px">
          <div style="text-align:center;margin-bottom:20px">
            <h2 style="color:#1F497D;font-size:18px;margin:0">にこっとweb App</h2>
            <p style="color:#6b7a99;font-size:12px;margin:4px 0 0">パスワードリセット</p>
          </div>
          <div style="background:#fff;border:1px solid #d0d7e3;border-radius:12px;padding:24px">
            <p style="font-size:14px;color:#1a2233;margin:0 0 16px">${staffName}さん</p>
            <p style="font-size:13px;color:#1a2233;line-height:1.7;margin:0 0 20px">パスワードリセットのリクエストを受け付けました。<br>以下のボタンをクリックして新しいパスワードを設定してください。</p>
            <div style="text-align:center;margin:24px 0">
              <a href="${resetUrl}" style="background:#2E75B6;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;display:inline-block">パスワードを再設定する</a>
            </div>
            <p style="font-size:11px;color:#6b7a99;margin:20px 0 0;line-height:1.6">
              ※ このリンクは30分間有効です。<br>
              ※ 心当たりのない場合は、このメールを無視してください。
            </p>
          </div>
          <p style="text-align:center;font-size:11px;color:#b0b8cc;margin:16px 0 0">にこっと訪問看護ステーション</p>
        </div>`,
    });
    console.log(`📧 パスワードリセットメール送信: ${staffName} → ${toEmail}`);
    return true;
  } catch (e) {
    if (attempt < maxRetries - 1) {
      const wait = Math.pow(2, attempt) * 1000;
      console.warn(`⚠️ メール送信失敗 (${attempt + 1}/${maxRetries}), ${wait}ms後にリトライ: ${e.message}`);
      await new Promise(r => setTimeout(r, wait));
    } else {
      console.error('❌ メール送信エラー（リトライ上限）:', e.message);
      return false;
    }
  }
  }
}

// 内部トランスポートを初期化
function initMail() {
  mailTransport = createMailTransport();
}

module.exports = {
  createMailTransport,
  sendResetEmail,
  initMail,
};
