const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

/**
 * KUANDA OS - CHAT SYSTEM (V-FINAL SAFE MODE)
 * - SQL corrigido para evitar travamento na inicialização.
 * - Sistema de notificação integrado.
 */

// --- 1. CONFIGURAÇÃO DE UPLOAD ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = 'public/uploads/chat/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        let ext = path.extname(file.originalname);
        if (file.mimetype === 'audio/webm' || file.originalname === 'audio.webm') ext = '.webm';
        if (!ext) ext = '.bin';
        cb(null, `chat-${unique}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } 
});

module.exports = function(app, db) {
    console.log('✅ [CHAT SYSTEM] Inicializando...');

    // --- 2. INICIALIZAÇÃO SEGURA DO BANCO DE DADOS ---
    const initChatDB = async () => {
        try {
            // Cria tabelas básicas (se não existirem)
            await db.query(`
                CREATE TABLE IF NOT EXISTS conversas (
                    id SERIAL PRIMARY KEY,
                    pedido_id INTEGER, 
                    participante_1 INTEGER REFERENCES usuarios(id),
                    participante_2 INTEGER REFERENCES usuarios(id),
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            await db.query(`
                CREATE TABLE IF NOT EXISTS mensagens (
                    id SERIAL PRIMARY KEY,
                    conversa_id INTEGER REFERENCES conversas(id) ON DELETE CASCADE,
                    remetente_id INTEGER,
                    conteudo TEXT,
                    tipo_acao VARCHAR(50) DEFAULT 'texto',
                    anexo_url VARCHAR(255),
                    anexo_tipo VARCHAR(50),
                    anexo_nome VARCHAR(255),
                    lida BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Tenta adicionar colunas faltantes (uma por uma para não quebrar)
            try {
                await db.query(`ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT FALSE;`);
            } catch (e) { console.log('Nota: Coluna is_system já existe ou erro ignorável.'); }

            try {
                await db.query(`ALTER TABLE conversas ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);
            } catch (e) { console.log('Nota: Coluna updated_at já existe ou erro ignorável.'); }

            console.log('✅ [CHAT SYSTEM] Banco de dados pronto.');
        } catch (error) {
            console.error('⚠️ [CHAT SYSTEM] Aviso de DB:', error.message);
            // Não relança o erro para não derrubar o servidor
        }
    };
    initChatDB();

    // --- 3. GATILHO GLOBAL DE NOTIFICAÇÃO ---
    app.sysNotification = async (remetenteId, destinatarioId, conteudo, tipoAcao = 'sistema', pedidoId = null) => {
        try {
            if (!remetenteId || !destinatarioId) return false;

            // 1. Achar/Criar Conversa
            let conversaId = null;
            const check = await db.query(`
                SELECT id FROM conversas 
                WHERE (participante_1 = $1 AND participante_2 = $2) 
                   OR (participante_1 = $2 AND participante_2 = $1)
                LIMIT 1
            `, [remetenteId, destinatarioId]);

            if (check.rows.length > 0) {
                conversaId = check.rows[0].id;
                // Atualiza timestamp
                await db.query('UPDATE conversas SET updated_at = NOW() WHERE id = $1', [conversaId]);
                // Se tiver pedido, vincula
                if(pedidoId) await db.query('UPDATE conversas SET pedido_id = $1 WHERE id = $2', [pedidoId, conversaId]);
            } else {
                const novo = await db.query(`
                    INSERT INTO conversas (participante_1, participante_2, pedido_id, updated_at, criado_em)
                    VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id
                `, [remetenteId, destinatarioId, pedidoId]);
                conversaId = novo.rows[0].id;
            }

            // 2. Inserir Mensagem
            await db.query(`
                INSERT INTO mensagens (conversa_id, remetente_id, conteudo, tipo_acao, lida, is_system, created_at)
                VALUES ($1, $2, $3, $4, false, true, NOW())
            `, [conversaId, remetenteId, conteudo, tipoAcao]);

            return true;
        } catch (error) {
            console.error('❌ Erro na notificação:', error.message);
            return false;
        }
    };

    // Middleware de Auth
    const isAuth = (req, res, next) => {
        if (req.session && req.session.user) return next();
        if (req.xhr) return res.status(401).json({error: 'Auth'});
        res.redirect('/login');
    };

    // --- 4. ROTA DE TELA (VIEW) ---
    app.get('/central-mensagens', isAuth, (req, res) => {
        try {
            res.render('chat', { 
                user: req.session.user,
                title: 'Mensagens - Kuanda OS' 
            });
        } catch (error) {
            console.error('Erro ao renderizar chat:', error);
            res.status(500).send("Erro ao carregar o chat. Verifique os logs.");
        }
    });

    // --- 5. APIs JSON ---

    // Listar
    app.get('/api/chat/conversas', isAuth, async (req, res) => {
        try {
            const myId = req.session.user.id;
            const q = req.query.q || '';
            
            const result = await db.query(`
                SELECT 
                    c.id, c.pedido_id, c.updated_at,
                    u1.nome as nome1, u1.nome_loja as loja1, u1.foto_perfil as foto1, u1.id as id1,
                    u2.nome as nome2, u2.nome_loja as loja2, u2.foto_perfil as foto2, u2.id as id2,
                    (SELECT conteudo FROM mensagens WHERE conversa_id = c.id ORDER BY created_at DESC LIMIT 1) as ultima_msg,
                    (SELECT tipo_acao FROM mensagens WHERE conversa_id = c.id ORDER BY created_at DESC LIMIT 1) as ultimo_tipo,
                    (SELECT COUNT(*) FROM mensagens WHERE conversa_id = c.id AND lida = false AND remetente_id != $1) as nao_lidas
                FROM conversas c
                LEFT JOIN usuarios u1 ON c.participante_1 = u1.id
                LEFT JOIN usuarios u2 ON c.participante_2 = u2.id
                WHERE (c.participante_1 = $1 OR c.participante_2 = $1)
                AND (u1.nome ILIKE $2 OR u2.nome ILIKE $2 OR u1.nome_loja ILIKE $2)
                ORDER BY c.updated_at DESC
            `, [myId, `%${q}%`]);

            const chats = result.rows.map(r => {
                const sou1 = r.id1 === myId;
                const alvo = sou1 ? {n: r.loja2||r.nome2, f: r.foto2, id: r.id2} : {n: r.loja1||r.nome1, f: r.foto1, id: r.id1};
                
                let prev = r.ultima_msg || 'Nova conversa';
                if(r.ultimo_tipo === 'imagem') prev = '📷 Imagem';
                if(r.ultimo_tipo === 'audio') prev = '🎤 Áudio';
                if(r.ultimo_tipo === 'compra') prev = '🛍️ Compra';
                if(r.ultimo_tipo === 'sistema' || r.ultimo_tipo === 'status') prev = '🔔 Notificação';

                return {
                    id: r.id, titulo: alvo.n, foto: alvo.f, target_id: alvo.id,
                    pedido_id: r.pedido_id, preview: prev, nao_lidas: parseInt(r.nao_lidas),
                    data: r.updated_at
                };
            });
            res.json(chats);
        } catch(e) { res.json([]); }
    });

    // Mensagens
    app.get('/api/chat/mensagens/:id', isAuth, async (req, res) => {
        try {
            await db.query(`UPDATE mensagens SET lida=true WHERE conversa_id=$1 AND remetente_id!=$2`, [req.params.id, req.session.user.id]);
            const r = await db.query(`
                SELECT m.*, u.nome, u.foto_perfil FROM mensagens m
                LEFT JOIN usuarios u ON m.remetente_id = u.id
                WHERE m.conversa_id=$1 ORDER BY m.created_at ASC
            `, [req.params.id]);
            res.json(r.rows);
        } catch(e) { res.json([]); }
    });

    // Enviar
    app.post('/api/chat/enviar', isAuth, upload.single('anexo'), async (req, res) => {
        try {
            const { conversa_id, conteudo, tipo_especifico } = req.body;
            let url = null, nome = null, tipo = 'texto';

            if(req.file) {
                url = req.file.filename;
                nome = req.file.originalname;
                tipo = tipo_especifico === 'audio' || req.file.mimetype.includes('audio') ? 'audio' : (req.file.mimetype.includes('image') ? 'imagem' : 'arquivo');
            }

            await db.query(`
                INSERT INTO mensagens (conversa_id, remetente_id, conteudo, tipo_acao, anexo_url, anexo_nome, is_system, lida, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, false, false, NOW())
            `, [conversa_id, req.session.user.id, conteudo || '', tipo, url, nome]);
            
            await db.query(`UPDATE conversas SET updated_at = NOW() WHERE id = $1`, [conversa_id]);
            res.json({success: true});
        } catch(e) { res.status(500).json({error: e.message}); }
    });

    // Iniciar
    app.post('/api/chat/iniciar', isAuth, async (req, res) => {
        try {
            const { target_id, pedido_id } = req.body;
            const myId = req.session.user.id;
            
            const check = await db.query(`SELECT id FROM conversas WHERE (participante_1=$1 AND participante_2=$2) OR (participante_1=$2 AND participante_2=$1)`, [myId, target_id]);
            
            if(check.rows.length > 0) {
                if(pedido_id) await db.query('UPDATE conversas SET pedido_id=$1 WHERE id=$2', [pedido_id, check.rows[0].id]);
                return res.json({id: check.rows[0].id});
            }

            const novo = await db.query(`INSERT INTO conversas (participante_1, participante_2, pedido_id, updated_at) VALUES ($1, $2, $3, NOW()) RETURNING id`, [myId, target_id, pedido_id || null]);
            res.json({id: novo.rows[0].id});
        } catch(e) { res.status(500).json({error: e.message}); }
    });

    // Check (Para o Frontend)
    app.get('/api/chat/check', isAuth, async (req, res) => {
        try {
            const r = await db.query(`
                SELECT COUNT(*) as total FROM mensagens m 
                JOIN conversas c ON m.conversa_id = c.id 
                WHERE (c.participante_1=$1 OR c.participante_2=$1) 
                AND m.lida=false AND m.remetente_id!=$1
            `, [req.session.user.id]);
            res.json({unread: parseInt(r.rows[0].total)});
        } catch(e) { res.json({unread: 0}); }
    });

    // Pedido
    app.get('/api/chat/pedido-detalhes/:id', isAuth, async (req, res) => {
        try {
            const p = await db.query('SELECT * FROM pedidos WHERE id=$1', [req.params.id]);
            if(p.rows.length === 0) return res.json(null);
            
            const i = await db.query(`
                SELECT ip.*, p.nome, CAST(p.imagem1 AS TEXT) as imagem1 
                FROM itens_pedido ip LEFT JOIN produtos p ON ip.produto_id=p.id WHERE ip.pedido_id=$1
            `, [req.params.id]);
            
            res.json({pedido: p.rows[0], itens: i.rows});
        } catch(e) { res.json(null); }
    });

    // Status
    app.post('/api/chat/status', isAuth, async (req, res) => {
        try {
            const { pedido_id, status, conversa_id } = req.body;
            await db.query('UPDATE pedidos SET status=$1 WHERE id=$2', [status, pedido_id]);
            const msg = `Status atualizado: ${status.toUpperCase()}`;
            await db.query(`INSERT INTO mensagens (conversa_id, remetente_id, conteudo, tipo_acao, is_system, created_at) VALUES ($1, $2, $3, 'status', true, NOW())`, [conversa_id, req.session.user.id, msg]);
            res.json({success: true});
        } catch(e) { res.status(500).json({error: e.message}); }
    });

    // Users
    app.get('/api/chat/usuarios-disponiveis', isAuth, async (req, res) => {
        try {
            const u = await db.query(`SELECT id, nome, nome_loja, foto_perfil FROM usuarios WHERE id!=$1 LIMIT 50`, [req.session.user.id]);
            res.json(u.rows);
        } catch(e) { res.json([]); }
    });
};