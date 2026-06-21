const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const port = 3000;

// 1. 設定 Middleware (中介軟體)
// 讓 Express 能夠解析前端表單送過來的 POST 資料
app.use(bodyParser.urlencoded({ extended: true }));
// 讓 Express 自動提供 public 資料夾下的靜態檔案 (你的 index.html)
app.use(express.static('public'));

// 2. 連線到 SQLite 資料庫
const db = new sqlite3.Database('./SQL.db', (err) => {
    if (err) {
        console.error('資料庫連線失敗：', err.message);
    } else {
        console.log('✅ 已成功連接到電子記帳本資料庫！');
    }
});

// 3. 處理新增帳目的 POST 請求 (對應前端表單的 action="/add-record")
app.post('/add-record', (req, res) => {
    // 從前端表單抓取資料 (對應 input 的 name 屬性)
    const { amount, category_id, date, note } = req.body;

    const sql = `INSERT INTO 帳目 (金額, "類別 ID", 日期, 備註) VALUES (?, ?, ?, ?)`;

    // 執行 SQL
    db.run(sql, [amount, category_id, date, note], function (err) {
        if (err) {
            console.error('寫入資料庫失敗：', err.message);
            return res.status(500).send('伺服器錯誤，寫入失敗。');
        }

        console.log(`🎉 成功新增一筆帳目！資料庫配發的 帳目 ID 為 ${this.lastID}`);
        // 資料寫入成功後，將網頁重新導向回首頁
        res.redirect('/');
    });
});
// 取得所有帳目記錄
app.get('/api/records', (req, res) => {
    const sql = `
        SELECT r."帳目 ID" AS id, r.金額 AS amount, r.日期 AS date, r.備註 AS note,
               c.name AS category
        FROM 帳目 r
        LEFT JOIN 類別 c ON r."類別 ID" = c."類別 ID"
        ORDER BY r.日期 DESC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows); // 把資料庫撈出來的資料變成 JSON 傳給前端
    });
});

// 刪除一筆帳目記錄
app.delete('/api/records/:id', (req, res) => {
    const { id } = req.params;
    const sql = `DELETE FROM 帳目 WHERE "帳目 ID" = ?`;
    db.run(sql, [id], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, deleted: this.changes });
    });
});


// 統計 API：計算各類別總花費，並合併對應的預算
app.get('/api/stats', (req, res) => {
    // 前端會傳 ?month=2026-06 這種格式，沒傳就抓全部
    const month = req.query.month; // 例如 "2026-06"

    const expenseSql = month
        ? `SELECT c.name as category, c."類別 ID" as category_id, SUM(r.金額) as total 
           FROM 帳目 r 
           JOIN 類別 c ON r."類別 ID" = c."類別 ID" 
           WHERE c.type = '支出' AND r.日期 LIKE ?
           GROUP BY c.name`
        : `SELECT c.name as category, c."類別 ID" as category_id, SUM(r.金額) as total 
           FROM 帳目 r 
           JOIN 類別 c ON r."類別 ID" = c."類別 ID" 
           WHERE c.type = '支出'
           GROUP BY c.name`;

    const expenseParams = month ? [`${month}%`] : [];

    db.all(expenseSql, expenseParams, (err, expenseRows) => {
        if (err) return res.status(500).json({ error: err.message });

        const budgetSql = month
            ? `SELECT 類別ID as category_id, 預算金額 as budget FROM 預算表 WHERE 月份 = ?`
            : `SELECT 類別ID as category_id, 預算金額 as budget FROM 預算表`;
        const budgetParams = month ? [month] : [];

        db.all(budgetSql, budgetParams, (err, budgetRows) => {
            if (err) return res.status(500).json({ error: err.message });

            // 把預算合併進對應的類別資料
            const merged = expenseRows.map(item => {
                const budgetItem = budgetRows.find(b => b.category_id === item.category_id);
                return {
                    category: item.category,
                    total: item.total,
                    budget: budgetItem ? budgetItem.budget : null
                };
            });

            res.json({ stats: merged });
        });
    });
});

// 摘要 API：計算本月收入、支出、結餘
app.get('/api/summary', (req, res) => {
    // 沒傳 month 就用今天所在的月份
    const month = req.query.month || (() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    })();

    const sql = `
        SELECT c.type as type, SUM(r.金額) as total
        FROM 帳目 r
        JOIN 類別 c ON r."類別 ID" = c."類別 ID"
        WHERE r.日期 LIKE ?
        GROUP BY c.type
    `;
    db.all(sql, [`${month}%`], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        let income = 0;
        let expense = 0;
        rows.forEach(r => {
            if (r.type === '收入') income = r.total;
            else if (r.type === '支出') expense = r.total;
        });

        res.json({ month, income, expense, balance: income - expense });
    });
});

// 新增 API：獲取所有類別清單
app.get('/api/categories', (req, res) => {
    // 記得欄位名稱有空格要用雙引號，並取別名方便前端存取
    const sql = `SELECT "類別 ID" AS id, name FROM 類別`;
    db.all(sql, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/budget', (req, res) => {
    const { month, category_id, amount } = req.body;
    // 先看這個月份+類別有沒有預算紀錄，有就更新，沒有就新增
    const checkSql = `SELECT 預算ID FROM 預算表 WHERE 月份 = ? AND 類別ID = ?`;
    db.get(checkSql, [month, category_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        if (row) {
            const updateSql = `UPDATE 預算表 SET 預算金額 = ? WHERE 預算ID = ?`;
            db.run(updateSql, [amount, row.預算ID], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            });
        } else {
            const insertSql = `INSERT INTO 預算表 (月份, 預算金額, 類別ID) VALUES (?, ?, ?)`;
            db.run(insertSql, [month, amount, category_id], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            });
        }
    });
});

// 4. 啟動伺服器
app.listen(port, () => {
    console.log(`🚀 伺服器已啟動，請打開瀏覽器輸入： http://localhost:${port}`);
});