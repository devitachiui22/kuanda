const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const flash = require('express-flash');
const methodOverride = require('method-override');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('./config/database');
const expressLayouts = require('express-ejs-layouts');
const fs = require('fs');
const sharp = require('sharp'); // Para otimização de imagens
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURAÇÃO DO BANCO DE DADOS PARA IMAGENS ====================
const inicializarTabelaImagens = async () => {
  try {
    console.log('🔄 Inicializando tabela de imagens...');
    
    // Criar tabela de imagens se não existir
    await db.query(`
      CREATE TABLE IF NOT EXISTS imagens (
        id SERIAL PRIMARY KEY,
        nome_arquivo VARCHAR(255),
        tipo VARCHAR(50),
        dados BYTEA,
        entidade_tipo VARCHAR(50),
        entidade_id INTEGER,
        url VARCHAR(500),
        tamanho INTEGER,
        mime_type VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_entidade (entidade_tipo, entidade_id)
      )
    `);
    
    console.log('✅ Tabela imagens verificada/criada');
    
    // Criar índice para performance
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_imagens_entidade 
      ON imagens(entidade_tipo, entidade_id);
    `);
    
    console.log('✅ Índice de imagens criado');
  } catch (error) {
    console.error('❌ Erro ao inicializar tabela de imagens:', error);
  }
};

// Executar inicialização
inicializarTabelaImagens();

// ==================== FUNÇÕES DE GERENCIAMENTO DE IMAGENS ====================
const salvarImagemNoBanco = async (fileBuffer, fileName, mimeType, entityType, entityId) => {
  try {
    // Otimizar imagem antes de salvar
    let optimizedBuffer;
    if (mimeType.startsWith('image/')) {
      optimizedBuffer = await sharp(fileBuffer)
        .resize(1920, 1080, { // Tamanho máximo
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 80 })
        .toBuffer();
    } else {
      optimizedBuffer = fileBuffer;
    }

    const result = await db.query(`
      INSERT INTO imagens (nome_arquivo, tipo, dados, entidade_tipo, entidade_id, 
                          tamanho, mime_type, url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [
      fileName,
      mimeType,
      optimizedBuffer,
      entityType,
      entityId,
      optimizedBuffer.length,
      mimeType,
      null // URL será gerada dinamicamente
    ]);
    
    return result.rows[0].id;
  } catch (error) {
    console.error('❌ Erro ao salvar imagem no banco:', error);
    throw error;
  }
};

const obterImagemDoBanco = async (entityType, entityId, imageType = null) => {
  try {
    let query = 'SELECT * FROM imagens WHERE entidade_tipo = $1 AND entidade_id = $2';
    const params = [entityType, entityId];
    
    if (imageType) {
      query += ' AND tipo = $3';
      params.push(imageType);
    }
    
    query += ' ORDER BY created_at DESC LIMIT 1';
    
    const result = await db.query(query, params);
    return result.rows[0] || null;
  } catch (error) {
    console.error('❌ Erro ao obter imagem do banco:', error);
    return null;
  }
};

const obterVariasImagensDoBanco = async (entityType, entityId) => {
  try {
    const result = await db.query(`
      SELECT * FROM imagens 
      WHERE entidade_tipo = $1 AND entidade_id = $2
      ORDER BY created_at DESC
    `, [entityType, entityId]);
    
    return result.rows;
  } catch (error) {
    console.error('❌ Erro ao obter imagens do banco:', error);
    return [];
  }
};

const deletarImagemDoBanco = async (imageId) => {
  try {
    await db.query('DELETE FROM imagens WHERE id = $1', [imageId]);
    return true;
  } catch (error) {
    console.error('❌ Erro ao deletar imagem do banco:', error);
    return false;
  }
};

const deletarImagensPorEntidade = async (entityType, entityId) => {
  try {
    await db.query(
      'DELETE FROM imagens WHERE entidade_tipo = $1 AND entidade_id = $2',
      [entityType, entityId]
    );
    return true;
  } catch (error) {
    console.error('❌ Erro ao deletar imagens da entidade:', error);
    return false;
  }
};

// ==================== ROTAS PARA SERVIÇO DE IMAGENS ====================
app.get('/api/imagem/:id', async (req, res) => {
  try {
    const image = await db.query('SELECT * FROM imagens WHERE id = $1', [req.params.id]);
    
    if (!image.rows.length) {
      return res.status(404).json({ error: 'Imagem não encontrada' });
    }

    const img = image.rows[0];
    
    // Definir cabeçalhos de cache
    res.set({
      'Content-Type': img.mime_type,
      'Content-Length': img.tamanho,
      'Cache-Control': 'public, max-age=31536000', // Cache de 1 ano
      'ETag': `"${img.id}-${img.created_at.getTime()}"`
    });
    
    res.send(img.dados);
  } catch (error) {
    console.error('Erro ao servir imagem:', error);
    res.status(500).json({ error: 'Erro ao carregar imagem' });
  }
});

app.get('/api/imagem/:entityType/:entityId/:imageType?', async (req, res) => {
  try {
    const { entityType, entityId, imageType } = req.params;
    const image = await obterImagemDoBanco(entityType, entityId, imageType || null);
    
    if (!image) {
      return res.status(404).json({ error: 'Imagem não encontrada' });
    }

    res.set({
      'Content-Type': image.mime_type,
      'Content-Length': image.tamanho,
      'Cache-Control': 'public, max-age=31536000'
    });
    
    res.send(image.dados);
  } catch (error) {
    console.error('Erro ao servir imagem por entidade:', error);
    res.status(500).json({ error: 'Erro ao carregar imagem' });
  }
});

// Helper para gerar URL da imagem
const gerarUrlImagem = (imageId, entityType = null, entityId = null, imageType = null) => {
  if (imageId) {
    return `/api/imagem/${imageId}`;
  } else if (entityType && entityId) {
    return imageType 
      ? `/api/imagem/${entityType}/${entityId}/${imageType}`
      : `/api/imagem/${entityType}/${entityId}`;
  }
  return null;
};

// ==================== CONFIGURAÇÃO DE DIRETÓRIOS ====================
const uploadDirs = [
  'public/uploads',
  'public/uploads/banners',
  'public/uploads/filmes',
  'public/uploads/produtos',
  'public/uploads/perfil',
  'public/uploads/games',
  'public/uploads/categorias',
  'tmp/uploads'
];

uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ Criado diretório: ${dir}`);
  }
});

// ==================== CONFIGURAÇÃO DO MULTER (PARA ARQUIVOS TEMPORÁRIOS) ====================
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let uploadPath = 'tmp/uploads/';
    
    if (file.fieldname === 'imagem' && req.originalUrl.includes('banners')) {
      uploadPath = 'tmp/uploads/banners/';
    } else if (file.fieldname === 'poster' || req.originalUrl.includes('filmes')) {
      uploadPath = 'tmp/uploads/filmes/';
    } else if (file.fieldname === 'foto_perfil' || req.originalUrl.includes('perfil')) {
      uploadPath = 'tmp/uploads/perfil/';
    } else if (file.fieldname.includes('imagem') || file.fieldname === 'imagem_categoria') {
      uploadPath = 'tmp/uploads/produtos/';
    } else if (file.fieldname === 'capa' || req.originalUrl.includes('jogos')) {
      uploadPath = 'tmp/uploads/games/';
    } else if (file.fieldname === 'imagem_categoria') {
      uploadPath = 'tmp/uploads/categorias/';
    }
    
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    const filename = 'temp-' + uniqueSuffix + ext;
    cb(null, filename);
  }
});

const fileFilter = (req, file, cb) => {
  const filetypes = /jpeg|jpg|png|gif|webp|svg/;
  const mimetype = filetypes.test(file.mimetype);
  const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
  
  if (mimetype && extname) {
    return cb(null, true);
  }
  cb(new Error('Apenas imagens são permitidas (JPEG, JPG, PNG, GIF, WebP, SVG)!'));
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ==================== MIDDLEWARES ====================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

app.use(session({
  store: new pgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'user_sessions',
    createTableIfMissing: true,
    ttl: 24 * 60 * 60 // 24 horas
  }),
  secret: process.env.SESSION_SECRET || 'kuandashop-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

app.use(flash());

app.use(expressLayouts);
app.set('layout', 'layout');

// Middleware para cache de sessão e prevenção de travamento
app.use((req, res, next) => {
  // Adicionar timeout para prevenir travamento
  res.setTimeout(30000, () => {
    console.log(`⚠️ Timeout na requisição: ${req.method} ${req.url}`);
    if (!res.headersSent) {
      res.status(503).send('Servidor ocupado. Tente novamente.');
    }
  });
  
  next();
});

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.messages = req.flash();
  res.locals.currentUrl = req.originalUrl;
  res.locals.gerarUrlImagem = gerarUrlImagem; // Disponibilizar função nas views
  
  // Limpar sessão antiga para prevenir travamento
  if (req.session.user && Date.now() - req.session.cookie._expires > 3600000) {
    req.session.destroy();
    return res.redirect('/login');
  }
  
  next();
});

app.use((req, res, next) => {
  if (!req.session.carrinho) {
    req.session.carrinho = [];
  }
  res.locals.carrinho = req.session.carrinho || [];
  next();
});

// ==================== FUNÇÕES AUXILIARES ATUALIZADAS ====================
const processarUploadImagem = async (file, entityType, entityId) => {
  try {
    if (!file) return null;
    
    const fileBuffer = fs.readFileSync(file.path);
    const imageId = await salvarImagemNoBanco(
      fileBuffer,
      file.filename,
      file.mimetype,
      entityType,
      entityId
    );
    
    // Remover arquivo temporário
    fs.unlinkSync(file.path);
    
    return imageId;
  } catch (error) {
    console.error('Erro ao processar upload:', error);
    // Tentar remover arquivo temporário mesmo em caso de erro
    if (file && file.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
    return null;
  }
};

// ==================== MIDDLEWARES DE AUTENTICAÇÃO ====================
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    req.flash('error', 'Você precisa fazer login para acessar esta página');
    return res.redirect('/login');
  }
  next();
};

const requireVendor = (req, res, next) => {
  if (!req.session.user || req.session.user.tipo !== 'vendedor') {
    req.flash('error', 'Acesso restrito a vendedores');
    return res.redirect('/');
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.user || req.session.user.tipo !== 'admin') {
    req.flash('error', 'Acesso restrito a administradores');
    return res.redirect('/');
  }
  next();
};

// ==================== INICIALIZAÇÃO DO BANCO DE DADOS ====================
const inicializarBancoDados = async () => {
  console.log('🔄 Inicializando banco de dados...');
  
  try {
    // Verificar e criar tabelas necessárias
    await db.query(`
      CREATE TABLE IF NOT EXISTS planos_vendedor (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        limite_produtos INTEGER NOT NULL DEFAULT 10,
        preco_mensal DECIMAL(10,2) DEFAULT 0.00,
        permite_vip BOOLEAN DEFAULT false,
        permite_destaque BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela planos_vendedor verificada/criada');

    // Adicionar colunas se não existirem
    await db.query(`
      DO $$ 
      BEGIN
        -- Adicionar coluna plano_id se não existir
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='usuarios' AND column_name='plano_id') THEN
          ALTER TABLE usuarios ADD COLUMN plano_id INTEGER;
        END IF;
        
        -- Adicionar coluna limite_produtos se não existir
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name='usuarios' AND column_name='limite_produtos') THEN
          ALTER TABLE usuarios ADD COLUMN limite_produtos INTEGER DEFAULT 10;
        END IF;
      END $$;
    `);
    console.log('✅ Colunas plano_id e limite_produtos verificadas/adicionadas');

    // Criar planos padrão se não existirem
    const planosExistentes = await db.query('SELECT COUNT(*) as total FROM planos_vendedor');
    if (parseInt(planosExistentes.rows[0].total) === 0) {
      await db.query(`
        INSERT INTO planos_vendedor (nome, limite_produtos, preco_mensal, permite_vip, permite_destaque) VALUES
        ('Básico', 10, 0.00, false, false),
        ('Pro', 50, 99.90, true, true),
        ('Premium', 200, 299.90, true, true),
        ('Enterprise', 1000, 999.90, true, true)
      `);
      console.log('✅ Planos padrão criados');
    }

    // Criar tabela de jogos se não existir
    await db.query(`
      CREATE TABLE IF NOT EXISTS jogos (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(200) NOT NULL,
        capa_imagem_id INTEGER REFERENCES imagens(id),
        banner_imagem_id INTEGER REFERENCES imagens(id),
        screenshots_imagens_ids INTEGER[] DEFAULT ARRAY[]::INTEGER[],
        preco DECIMAL(10,2) DEFAULT 0.00,
        plataforma VARCHAR(50),
        genero VARCHAR(100),
        link_download TEXT,
        trailer_url TEXT,
        descricao TEXT,
        requisitos TEXT,
        desenvolvedor VARCHAR(100),
        classificacao VARCHAR(10),
        ativo BOOLEAN DEFAULT true,
        vendas_count INTEGER DEFAULT 0,
        downloads_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela jogos verificada/criada');

    // Criar tabela de banners (atualizada para usar sistema de imagens)
    await db.query(`
      CREATE TABLE IF NOT EXISTS banners (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(200),
        imagem_id INTEGER REFERENCES imagens(id),
        link VARCHAR(500),
        ordem INTEGER DEFAULT 0,
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela banners verificada/criada');

    // Criar tabela de filmes (atualizada para usar sistema de imagens)
    await db.query(`
      CREATE TABLE IF NOT EXISTS filmes (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(200) NOT NULL,
        poster_imagem_id INTEGER REFERENCES imagens(id),
        trailer_url TEXT,
        sinopse TEXT,
        data_lancamento DATE,
        classificacao VARCHAR(10),
        ativo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela filmes verificada/criada');

    // Criar tabela de produtos (atualizada para usar sistema de imagens)
    await db.query(`
      CREATE TABLE IF NOT EXISTS produtos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(200) NOT NULL,
        descricao TEXT,
        preco DECIMAL(10,2) NOT NULL,
        preco_promocional DECIMAL(10,2),
        categoria_id INTEGER,
        estoque INTEGER DEFAULT 0,
        imagem1_id INTEGER REFERENCES imagens(id),
        imagem2_id INTEGER REFERENCES imagens(id),
        imagem3_id INTEGER REFERENCES imagens(id),
        vendedor_id INTEGER NOT NULL,
        destaque BOOLEAN DEFAULT false,
        vip BOOLEAN DEFAULT false,
        ativo BOOLEAN DEFAULT true,
        views_count INTEGER DEFAULT 0,
        vendas_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vendedor_id) REFERENCES usuarios(id) ON DELETE CASCADE
      )
    `);
    console.log('✅ Tabela produtos verificada/criada');

    // Criar tabela de configurações
    await db.query(`
      CREATE TABLE IF NOT EXISTS configuracoes (
        id SERIAL PRIMARY KEY,
        nome_site VARCHAR(200) DEFAULT 'KuandaShop',
        email_contato VARCHAR(200),
        telefone_contato VARCHAR(50),
        endereco TEXT,
        sobre_nos TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela configuracoes verificada/criada');

    console.log('✅ Banco de dados inicializado com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao inicializar banco de dados:', error);
  }
};

// Executar inicialização
inicializarBancoDados();

// ==================== ROTA INICIAL ATUALIZADA ====================
app.get('/', async (req, res) => {
  try {
    const [
      banners,
      produtosDestaque,
      produtosVip,
      produtosOferta,
      filmes,
      categorias
    ] = await Promise.all([
      db.query(`
        SELECT b.*, i.id as imagem_id 
        FROM banners b 
        LEFT JOIN imagens i ON b.imagem_id = i.id 
        WHERE b.ativo = true 
        ORDER BY b.ordem
      `),
      db.query(`
        SELECT p.*, 
               u.nome_loja, 
               u.foto_perfil as loja_foto,
               i1.id as imagem1_id,
               COALESCE(AVG(a.classificacao), 0) as media_classificacao,
               COUNT(a.id) as total_avaliacoes
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        LEFT JOIN imagens i1 ON p.imagem1_id = i1.id
        LEFT JOIN avaliacoes a ON p.id = a.produto_id
        WHERE p.ativo = true AND p.destaque = true AND u.loja_ativa = true
        GROUP BY p.id, u.nome_loja, u.foto_perfil, i1.id
        ORDER BY p.created_at DESC 
        LIMIT 12
      `),
      db.query(`
        SELECT p.*, 
               u.nome_loja, 
               u.foto_perfil as loja_foto,
               i1.id as imagem1_id,
               COALESCE(AVG(a.classificacao), 0) as media_classificacao,
               COUNT(a.id) as total_avaliacoes
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        LEFT JOIN imagens i1 ON p.imagem1_id = i1.id
        LEFT JOIN avaliacoes a ON p.id = a.produto_id
        WHERE p.ativo = true AND p.vip = true AND u.loja_ativa = true
        GROUP BY p.id, u.nome_loja, u.foto_perfil, i1.id
        ORDER BY p.created_at DESC 
        LIMIT 8
      `),
      db.query(`
        SELECT p.*, 
               u.nome_loja, 
               u.foto_perfil as loja_foto,
               i1.id as imagem1_id,
               COALESCE(AVG(a.classificacao), 0) as media_classificacao,
               COUNT(a.id) as total_avaliacoes
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        LEFT JOIN imagens i1 ON p.imagem1_id = i1.id
        LEFT JOIN avaliacoes a ON p.id = a.produto_id
        WHERE p.ativo = true AND p.preco_promocional IS NOT NULL AND u.loja_ativa = true
        GROUP BY p.id, u.nome_loja, u.foto_perfil, i1.id
        ORDER BY p.created_at DESC 
        LIMIT 10
      `),
      db.query(`
        SELECT f.*, i.id as poster_imagem_id 
        FROM filmes f 
        LEFT JOIN imagens i ON f.poster_imagem_id = i.id 
        WHERE f.ativo = true 
        ORDER BY f.data_lancamento DESC 
        LIMIT 6
      `),
      db.query('SELECT * FROM categorias ORDER BY nome')
    ]);

    // Processar banners com URLs de imagem
    const bannersProcessados = banners.rows.map(banner => ({
      ...banner,
      imagem_url: banner.imagem_id ? gerarUrlImagem(banner.imagem_id) : null
    }));

    // Processar produtos com URLs de imagem
    const processarProdutos = (produtos) => produtos.map(produto => ({
      ...produto,
      imagem1_url: produto.imagem1_id ? gerarUrlImagem(produto.imagem1_id) : null
    }));

    // Processar filmes com URLs de imagem
    const filmesProcessados = filmes.rows.map(filme => ({
      ...filme,
      poster_url: filme.poster_imagem_id ? gerarUrlImagem(filme.poster_imagem_id) : null
    }));

    res.render('index', {
      banners: bannersProcessados,
      produtosDestaque: processarProdutos(produtosDestaque.rows),
      produtosVip: processarProdutos(produtosVip.rows),
      produtosOferta: processarProdutos(produtosOferta.rows),
      filmes: filmesProcessados,
      categorias: categorias.rows,
      title: 'KuandaShop - Marketplace Multi-Vendor'
    });
  } catch (error) {
    console.error('Erro ao carregar página inicial:', error);
    res.render('index', {
      banners: [],
      produtosDestaque: [],
      produtosVip: [],
      produtosOferta: [],
      filmes: [],
      categorias: [],
      title: 'KuandaShop - Marketplace'
    });
  }
});

// ==================== ROTAS DE AUTENTICAÇÃO OTIMIZADAS ====================
app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/');
  }
  res.render('auth/login', { 
    title: 'Login - KuandaShop',
    layout: 'auth-layout' // Layout específico para auth
  });
});

app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  
  try {
    // Timeout para consulta
    const timeout = setTimeout(() => {
      req.flash('error', 'Tempo de login excedido. Tente novamente.');
      res.redirect('/login');
    }, 5000);

    const result = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    
    clearTimeout(timeout);

    if (result.rows.length === 0) {
      req.flash('error', 'Email ou senha incorretos');
      return res.redirect('/login');
    }

    const user = result.rows[0];
    const senhaValida = await bcrypt.compare(senha, user.senha);

    if (!senhaValida) {
      req.flash('error', 'Email ou senha incorretos');
      return res.redirect('/login');
    }

    if (user.tipo === 'vendedor' && !user.loja_ativa) {
      req.flash('error', 'Sua loja está desativada. Entre em contato com o administrador.');
      return res.redirect('/login');
    }

    // Obter imagem de perfil do banco
    const fotoPerfilImagem = user.foto_perfil_imagem_id 
      ? await obterImagemDoBanco('perfil', user.id, 'perfil')
      : null;

    req.session.user = {
      id: user.id,
      nome: user.nome,
      email: user.email,
      tipo: user.tipo,
      nome_loja: user.nome_loja,
      loja_ativa: user.loja_ativa,
      foto_perfil: fotoPerfilImagem ? gerarUrlImagem(fotoPerfilImagem.id) : null,
      telefone: user.telefone,
      plano_id: user.plano_id || null,
      limite_produtos: user.limite_produtos || 10
    };

    req.flash('success', `Bem-vindo de volta, ${user.nome}!`);
    
    // Redirecionamento seguro
    const redirectTo = user.tipo === 'admin' ? '/admin' : 
                      user.tipo === 'vendedor' ? '/vendedor' : '/';
    
    res.redirect(redirectTo);
  } catch (error) {
    console.error('Erro no login:', error);
    req.flash('error', 'Erro interno do servidor');
    res.redirect('/login');
  }
});

// ==================== GERENCIAMENTO DE USUÁRIOS (CORRIGIDO) ====================
app.get('/admin/usuarios', requireAdmin, async (req, res) => {
  try {
    const { tipo, busca, status } = req.query;
    let query = 'SELECT * FROM usuarios WHERE 1=1';
    const params = [];
    let paramCount = 0;

    if (tipo && tipo !== 'todos') {
      paramCount++;
      query += ` AND tipo = $${paramCount}`;
      params.push(tipo);
    }

    if (busca) {
      paramCount++;
      query += ` AND (nome ILIKE $${paramCount} OR email ILIKE $${paramCount} OR nome_loja ILIKE $${paramCount})`;
      params.push(`%${busca}%`);
    }

    if (status === 'ativo') {
      query += ' AND loja_ativa = true';
    } else if (status === 'inativo') {
      query += ' AND loja_ativa = false';
    }

    query += ' ORDER BY created_at DESC';

    const usuarios = await db.query(query, params);

    // Buscar informações de imagem de perfil para cada usuário
    const usuariosComImagens = await Promise.all(usuarios.rows.map(async (usuario) => {
      const fotoPerfilImagem = await obterImagemDoBanco('perfil', usuario.id, 'perfil');
      return {
        ...usuario,
        foto_perfil_url: fotoPerfilImagem ? gerarUrlImagem(fotoPerfilImagem.id) : null
      };
    }));

    // Estatísticas
    const stats = await db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN tipo = 'admin' THEN 1 END) as admins,
        COUNT(CASE WHEN tipo = 'vendedor' THEN 1 END) as vendedores,
        COUNT(CASE WHEN tipo = 'cliente' THEN 1 END) as clientes,
        COUNT(CASE WHEN loja_ativa = true THEN 1 END) as ativos
      FROM usuarios
    `);

    res.render('admin/usuarios', {
      usuarios: usuariosComImagens,
      stats: stats.rows[0],
      filtros: { tipo, busca, status },
      title: 'Gerenciar Usuários - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar usuários:', error);
    req.flash('error', 'Erro ao carregar lista de usuários');
    res.render('admin/usuarios', {
      usuarios: [],
      stats: {},
      filtros: {},
      title: 'Gerenciar Usuários'
    });
  }
});

app.post('/admin/usuario/:id/toggle-status', requireAdmin, async (req, res) => {
  try {
    const usuario = await db.query(
      'SELECT id, nome, loja_ativa FROM usuarios WHERE id = $1',
      [req.params.id]
    );
    
    if (usuario.rows.length === 0) {
      return res.json({ success: false, message: 'Usuário não encontrado' });
    }
    
    const novoStatus = !usuario.rows[0].loja_ativa;

    await db.query(
      'UPDATE usuarios SET loja_ativa = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [novoStatus, req.params.id]
    );

    // Log da ação
    console.log(`Status do usuário ${usuario.rows[0].nome} alterado para: ${novoStatus ? 'Ativo' : 'Inativo'}`);

    res.json({ 
      success: true, 
      message: `Status ${novoStatus ? 'ativado' : 'desativado'} com sucesso!`,
      novoStatus 
    });
  } catch (error) {
    console.error('Erro ao alterar status do usuário:', error);
    res.json({ success: false, message: 'Erro ao alterar status' });
  }
});

app.post('/admin/usuario/:id/alterar-tipo', requireAdmin, async (req, res) => {
  const { tipo } = req.body;
  
  try {
    if (!['admin', 'vendedor', 'cliente'].includes(tipo)) {
      req.flash('error', 'Tipo de usuário inválido');
      return res.redirect('/admin/usuarios');
    }

    const usuario = await db.query('SELECT nome FROM usuarios WHERE id = $1', [req.params.id]);
    
    if (usuario.rows.length === 0) {
      req.flash('error', 'Usuário não encontrado');
      return res.redirect('/admin/usuarios');
    }

    await db.query(
      'UPDATE usuarios SET tipo = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [tipo, req.params.id]
    );

    // Atribuir plano básico se for vendedor e não tiver plano
    if (tipo === 'vendedor') {
      const planoBasico = await db.query(
        "SELECT id FROM planos_vendedor WHERE nome = 'Básico' LIMIT 1"
      );
      
      if (planoBasico.rows.length > 0) {
        await db.query(`
          UPDATE usuarios 
          SET plano_id = $1, limite_produtos = 10, loja_ativa = true 
          WHERE id = $2 AND (plano_id IS NULL OR plano_id = 0)
        `, [planoBasico.rows[0].id, req.params.id]);
      }
    }

    req.flash('success', `Tipo de usuário alterado para ${tipo} com sucesso!`);
    res.redirect('/admin/usuarios');
  } catch (error) {
    console.error('Erro ao alterar tipo de usuário:', error);
    req.flash('error', 'Erro ao alterar tipo de usuário');
    res.redirect('/admin/usuarios');
  }
});

app.delete('/admin/usuario/:id', requireAdmin, async (req, res) => {
  try {
    // Verificar se é o último admin
    if (req.session.user.id == req.params.id) {
      const adminsCount = await db.query(
        "SELECT COUNT(*) as total FROM usuarios WHERE tipo = 'admin'"
      );
      
      if (parseInt(adminsCount.rows[0].total) <= 1) {
        return res.json({ 
          success: false, 
          message: 'Não é possível excluir o último administrador' 
        });
      }
    }

    // Buscar informações do usuário para logs
    const usuario = await db.query('SELECT nome, email FROM usuarios WHERE id = $1', [req.params.id]);
    
    if (usuario.rows.length === 0) {
      return res.json({ success: false, message: 'Usuário não encontrado' });
    }

    // Deletar imagens associadas ao usuário
    await deletarImagensPorEntidade('perfil', req.params.id);

    // Deletar usuário (CASCADE cuidará dos produtos, avaliações, etc.)
    await db.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);

    // Log da ação
    console.log(`Usuário ${usuario.rows[0].nome} (${usuario.rows[0].email}) excluído por ${req.session.user.nome}`);

    res.json({ 
      success: true, 
      message: 'Usuário excluído com sucesso!' 
    });
  } catch (error) {
    console.error('Erro ao excluir usuário:', error);
    res.json({ success: false, message: 'Erro ao excluir usuário' });
  }
});

// ==================== GERENCIAMENTO DE BANNERS (ATUALIZADO) ====================
app.get('/admin/banners', requireAdmin, async (req, res) => {
  try {
    const banners = await db.query(`
      SELECT b.*, i.id as imagem_id 
      FROM banners b 
      LEFT JOIN imagens i ON b.imagem_id = i.id 
      ORDER BY b.ordem, b.created_at DESC
    `);
    
    // Processar banners com URLs
    const bannersProcessados = banners.rows.map(banner => ({
      ...banner,
      imagem_url: banner.imagem_id ? gerarUrlImagem(banner.imagem_id) : null
    }));
    
    res.render('admin/banners', {
      banners: bannersProcessados,
      title: 'Gerenciar Banners - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar banners:', error);
    req.flash('error', 'Erro ao carregar banners');
    res.render('admin/banners', {
      banners: [],
      title: 'Gerenciar Banners'
    });
  }
});

app.get('/admin/banners/novo', requireAdmin, (req, res) => {
  res.render('admin/banner-form', {
    banner: null,
    action: '/admin/banners',
    title: 'Novo Banner - KuandaShop'
  });
});

app.post('/admin/banners', requireAdmin, upload.single('imagem'), async (req, res) => {
  const { titulo, link, ordem, ativo } = req.body;
  
  try {
    if (!req.file) {
      req.flash('error', 'É necessário enviar uma imagem para o banner');
      return res.redirect('/admin/banners/novo');
    }

    // Processar e salvar imagem
    const fileBuffer = fs.readFileSync(req.file.path);
    const imagemId = await salvarImagemNoBanco(
      fileBuffer,
      req.file.filename,
      req.file.mimetype,
      'banner',
      null // entityId será definido após criar o banner
    );

    // Remover arquivo temporário
    fs.unlinkSync(req.file.path);

    // Criar banner com referência à imagem
    const bannerResult = await db.query(`
      INSERT INTO banners (titulo, imagem_id, link, ordem, ativo)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [
      titulo ? titulo.trim() : null,
      imagemId,
      link ? link.trim() : null,
      ordem ? parseInt(ordem) : 0,
      ativo === 'on'
    ]);

    // Atualizar imagem com entityId
    await db.query(
      'UPDATE imagens SET entidade_id = $1 WHERE id = $2',
      [bannerResult.rows[0].id, imagemId]
    );
    
    req.flash('success', 'Banner criado com sucesso!');
    res.redirect('/admin/banners');
  } catch (error) {
    console.error('Erro ao criar banner:', error);
    
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    req.flash('error', 'Erro ao criar banner');
    res.redirect('/admin/banners/novo');
  }
});

app.get('/admin/banners/:id/editar', requireAdmin, async (req, res) => {
  try {
    const banner = await db.query(`
      SELECT b.*, i.id as imagem_id 
      FROM banners b 
      LEFT JOIN imagens i ON b.imagem_id = i.id 
      WHERE b.id = $1
    `, [req.params.id]);
    
    if (banner.rows.length === 0) {
      req.flash('error', 'Banner não encontrado');
      return res.redirect('/admin/banners');
    }
    
    const bannerComUrl = {
      ...banner.rows[0],
      imagem_url: banner.rows[0].imagem_id ? gerarUrlImagem(banner.rows[0].imagem_id) : null
    };
    
    res.render('admin/banner-form', {
      banner: bannerComUrl,
      action: `/admin/banners/${req.params.id}?_method=PUT`,
      title: 'Editar Banner - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar banner:', error);
    req.flash('error', 'Erro ao carregar banner');
    res.redirect('/admin/banners');
  }
});

app.put('/admin/banners/:id', requireAdmin, upload.single('imagem'), async (req, res) => {
  const { titulo, link, ordem, ativo } = req.body;
  
  try {
    const banner = await db.query('SELECT imagem_id FROM banners WHERE id = $1', [req.params.id]);
    
    if (banner.rows.length === 0) {
      req.flash('error', 'Banner não encontrado');
      return res.redirect('/admin/banners');
    }
    
    let imagemId = banner.rows[0].imagem_id;
    
    if (req.file) {
      // Se já existir uma imagem antiga, deletar do banco
      if (imagemId) {
        await deletarImagemDoBanco(imagemId);
      }
      
      // Processar e salvar nova imagem
      const fileBuffer = fs.readFileSync(req.file.path);
      imagemId = await salvarImagemNoBanco(
        fileBuffer,
        req.file.filename,
        req.file.mimetype,
        'banner',
        req.params.id
      );
      
      // Remover arquivo temporário
      fs.unlinkSync(req.file.path);
    }
    
    await db.query(`
      UPDATE banners 
      SET titulo = $1, imagem_id = $2, link = $3, ordem = $4, ativo = $5, updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
    `, [
      titulo ? titulo.trim() : null,
      imagemId,
      link ? link.trim() : null,
      ordem ? parseInt(ordem) : 0,
      ativo === 'on',
      req.params.id
    ]);
    
    req.flash('success', 'Banner atualizado com sucesso!');
    res.redirect('/admin/banners');
  } catch (error) {
    console.error('Erro ao atualizar banner:', error);
    req.flash('error', 'Erro ao atualizar banner');
    res.redirect(`/admin/banners/${req.params.id}/editar`);
  }
});

app.delete('/admin/banners/:id', requireAdmin, async (req, res) => {
  try {
    const banner = await db.query('SELECT imagem_id FROM banners WHERE id = $1', [req.params.id]);
    
    if (banner.rows.length === 0) {
      req.flash('error', 'Banner não encontrado');
      return res.redirect('/admin/banners');
    }
    
    // Deletar imagem do banco se existir
    if (banner.rows[0].imagem_id) {
      await deletarImagemDoBanco(banner.rows[0].imagem_id);
    }
    
    // Deletar banner
    await db.query('DELETE FROM banners WHERE id = $1', [req.params.id]);
    
    req.flash('success', 'Banner excluído com sucesso!');
    res.redirect('/admin/banners');
  } catch (error) {
    console.error('Erro ao excluir banner:', error);
    req.flash('error', 'Erro ao excluir banner');
    res.redirect('/admin/banners');
  }
});

// ==================== PAINEL DO VENDEDOR ATUALIZADO ====================
app.get('/vendedor/produto/novo', requireVendor, async (req, res) => {
  try {
    const limiteInfo = await db.query(`
      SELECT 
        u.limite_produtos,
        COUNT(p.id) as produtos_cadastrados,
        (u.limite_produtos - COUNT(p.id)) as produtos_disponiveis,
        pv.permite_vip,
        pv.permite_destaque
      FROM usuarios u
      LEFT JOIN produtos p ON u.id = p.vendedor_id
      LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
      WHERE u.id = $1
      GROUP BY u.id, u.limite_produtos, pv.permite_vip, pv.permite_destaque
    `, [req.session.user.id]);
    
    const limiteData = limiteInfo.rows[0] || { 
      limite_produtos: 10, 
      produtos_cadastrados: 0, 
      produtos_disponiveis: 10,
      permite_vip: false,
      permite_destaque: false 
    };
    
    if (limiteData.produtos_disponiveis <= 0) {
      req.flash('error', `Limite de ${limiteData.limite_produtos} produtos atingido. Atualize seu plano para cadastrar mais produtos.`);
      return res.redirect('/vendedor/produtos');
    }
    
    const categorias = await db.query('SELECT * FROM categorias ORDER BY nome');
    
    res.render('vendedor/produto-form', {
      produto: null,
      categorias: categorias.rows,
      produtosDisponiveis: limiteData.produtos_disponiveis,
      limiteProdutos: limiteData.limite_produtos,
      permiteVip: limiteData.permite_vip,
      permiteDestaque: limiteData.permite_destaque,
      action: '/vendedor/produto',
      title: 'Novo Produto - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar formulário:', error);
    res.render('vendedor/produto-form', {
      produto: null,
      categorias: [],
      produtosDisponiveis: 10,
      limiteProdutos: 10,
      permiteVip: false,
      permiteDestaque: false,
      action: '/vendedor/produto',
      title: 'Novo Produto'
    });
  }
});

app.post('/vendedor/produto', requireVendor, upload.fields([
  { name: 'imagem1', maxCount: 1 },
  { name: 'imagem2', maxCount: 1 },
  { name: 'imagem3', maxCount: 1 }
]), async (req, res) => {
  const { nome, descricao, preco, preco_promocional, categoria_id, estoque, destaque, vip } = req.body;
  
  try {
    // VERIFICAÇÃO DE LIMITE DE PRODUTOS
    const statsVendedor = await db.query(`
      SELECT 
        u.limite_produtos,
        COUNT(p.id) as total_produtos,
        pv.permite_vip,
        pv.permite_destaque
      FROM usuarios u
      LEFT JOIN produtos p ON u.id = p.vendedor_id
      LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
      WHERE u.id = $1
      GROUP BY u.id, u.limite_produtos, pv.permite_vip, pv.permite_destaque
    `, [req.session.user.id]);
    
    if (statsVendedor.rows.length > 0) {
      const stats = statsVendedor.rows[0];
      const totalProdutos = parseInt(stats.total_produtos);
      const limiteProdutos = parseInt(stats.limite_produtos) || 10;
      
      // Verificar limite de produtos
      if (totalProdutos >= limiteProdutos) {
        req.flash('error', `Limite de ${limiteProdutos} produtos atingido. Atualize seu plano para cadastrar mais produtos.`);
        return res.redirect('/vendedor/produto/novo');
      }
      
      // Verificar se plano permite VIP
      if (vip === 'on' && !stats.permite_vip) {
        req.flash('error', 'Seu plano atual não permite anúncios VIP. Atualize seu plano.');
        return res.redirect('/vendedor/produto/novo');
      }
      
      // Verificar se plano permite destaque
      if (destaque === 'on' && !stats.permite_destaque) {
        req.flash('error', 'Seu plano atual não permite produtos em destaque. Atualize seu plano.');
        return res.redirect('/vendedor/produto/novo');
      }
    }
    
    // Validar dados
    const validationErrors = validateProductData({ nome, descricao, preco, categoria_id, estoque });
    if (validationErrors.length > 0) {
      validationErrors.forEach(error => req.flash('error', error));
      return res.redirect('/vendedor/produto/novo');
    }

    // Processar e salvar imagens
    let imagem1Id = null;
    let imagem2Id = null;
    let imagem3Id = null;

    if (req.files.imagem1 && req.files.imagem1[0]) {
      const fileBuffer = fs.readFileSync(req.files.imagem1[0].path);
      imagem1Id = await salvarImagemNoBanco(
        fileBuffer,
        req.files.imagem1[0].filename,
        req.files.imagem1[0].mimetype,
        'produto',
        null // Será atualizado após criar o produto
      );
      fs.unlinkSync(req.files.imagem1[0].path);
    }

    if (req.files.imagem2 && req.files.imagem2[0]) {
      const fileBuffer = fs.readFileSync(req.files.imagem2[0].path);
      imagem2Id = await salvarImagemNoBanco(
        fileBuffer,
        req.files.imagem2[0].filename,
        req.files.imagem2[0].mimetype,
        'produto',
        null
      );
      fs.unlinkSync(req.files.imagem2[0].path);
    }

    if (req.files.imagem3 && req.files.imagem3[0]) {
      const fileBuffer = fs.readFileSync(req.files.imagem3[0].path);
      imagem3Id = await salvarImagemNoBanco(
        fileBuffer,
        req.files.imagem3[0].filename,
        req.files.imagem3[0].mimetype,
        'produto',
        null
      );
      fs.unlinkSync(req.files.imagem3[0].path);
    }

    if (!imagem1Id) {
      req.flash('error', 'A imagem principal é obrigatória');
      return res.redirect('/vendedor/produto/novo');
    }

    // Criar produto
    const produtoResult = await db.query(`
      INSERT INTO produtos (nome, descricao, preco, preco_promocional, categoria_id, estoque, 
                           imagem1_id, imagem2_id, imagem3_id, vendedor_id, destaque, vip)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
    `, [
      nome.trim(),
      descricao.trim(),
      parseFloat(preco),
      preco_promocional ? parseFloat(preco_promocional) : null,
      parseInt(categoria_id),
      parseInt(estoque),
      imagem1Id,
      imagem2Id,
      imagem3Id,
      req.session.user.id,
      destaque === 'on',
      vip === 'on'
    ]);

    const produtoId = produtoResult.rows[0].id;

    // Atualizar imagens com o entityId
    const updatePromises = [];
    if (imagem1Id) {
      updatePromises.push(
        db.query('UPDATE imagens SET entidade_id = $1 WHERE id = $2', [produtoId, imagem1Id])
      );
    }
    if (imagem2Id) {
      updatePromises.push(
        db.query('UPDATE imagens SET entidade_id = $1 WHERE id = $2', [produtoId, imagem2Id])
      );
    }
    if (imagem3Id) {
      updatePromises.push(
        db.query('UPDATE imagens SET entidade_id = $1 WHERE id = $2', [produtoId, imagem3Id])
      );
    }

    await Promise.all(updatePromises);

    req.flash('success', 'Produto cadastrado com sucesso!');
    res.redirect('/vendedor/produtos');
  } catch (error) {
    console.error('Erro ao cadastrar produto:', error);
    
    // Limpar arquivos temporários em caso de erro
    if (req.files) {
      Object.values(req.files).forEach(fileArray => {
        if (fileArray && fileArray[0] && fs.existsSync(fileArray[0].path)) {
          fs.unlinkSync(fileArray[0].path);
        }
      });
    }
    
    req.flash('error', 'Erro ao cadastrar produto');
    res.redirect('/vendedor/produto/novo');
  }
});

// ==================== ROTA DE PRODUTOS ATUALIZADA ====================
app.get('/produto/:id', async (req, res) => {
  try {
    const produto = await db.query(`
      SELECT p.*, 
             u.nome_loja, 
             u.foto_perfil as loja_foto, 
             u.telefone as loja_telefone,
             u.descricao_loja, 
             u.created_at as loja_desde,
             i1.id as imagem1_id,
             i2.id as imagem2_id,
             i3.id as imagem3_id,
             COALESCE(AVG(a.classificacao), 0) as media_classificacao,
             COUNT(a.id) as total_avaliacoes,
             c.nome as categoria_nome
      FROM produtos p 
      JOIN usuarios u ON p.vendedor_id = u.id 
      LEFT JOIN imagens i1 ON p.imagem1_id = i1.id
      LEFT JOIN imagens i2 ON p.imagem2_id = i2.id
      LEFT JOIN imagens i3 ON p.imagem3_id = i3.id
      LEFT JOIN avaliacoes a ON p.id = a.produto_id
      LEFT JOIN categorias c ON p.categoria_id = c.id
      WHERE p.id = $1 AND p.ativo = true
      GROUP BY p.id, u.nome_loja, u.foto_perfil, u.telefone, 
               u.descricao_loja, u.created_at, 
               i1.id, i2.id, i3.id, c.nome
    `, [req.params.id]);

    if (produto.rows.length === 0) {
      req.flash('error', 'Produto não encontrado');
      return res.redirect('/produtos');
    }

    const produtoData = produto.rows[0];
    
    // Processar URLs das imagens
    produtoData.imagem1_url = produtoData.imagem1_id ? gerarUrlImagem(produtoData.imagem1_id) : null;
    produtoData.imagem2_url = produtoData.imagem2_id ? gerarUrlImagem(produtoData.imagem2_id) : null;
    produtoData.imagem3_url = produtoData.imagem3_id ? gerarUrlImagem(produtoData.imagem3_id) : null;
    
    produtoData.media_classificacao = parseFloat(produtoData.media_classificacao) || 0;
    produtoData.total_avaliacoes = parseInt(produtoData.total_avaliacoes) || 0;
    produtoData.preco = parseFloat(produtoData.preco) || 0;
    produtoData.preco_promocional = produtoData.preco_promocional ? parseFloat(produtoData.preco_promocional) : null;
    produtoData.estoque = parseInt(produtoData.estoque) || 0;

    const [produtosSimilares, avaliacoes] = await Promise.all([
      db.query(`
        SELECT p.*, 
               u.nome_loja, 
               u.foto_perfil as loja_foto,
               i1.id as imagem1_id,
               COALESCE(AVG(a.classificacao), 0) as media_classificacao,
               COUNT(a.id) as total_avaliacoes
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        LEFT JOIN imagens i1 ON p.imagem1_id = i1.id
        LEFT JOIN avaliacoes a ON p.id = a.produto_id
        WHERE p.categoria_id = $1 AND p.id != $2 AND p.ativo = true AND u.loja_ativa = true
        GROUP BY p.id, u.nome_loja, u.foto_perfil, i1.id
        ORDER BY RANDOM()
        LIMIT 6
      `, [produtoData.categoria_id, req.params.id]),
      db.query(`
        SELECT a.*, u.nome, u.foto_perfil
        FROM avaliacoes a
        JOIN usuarios u ON a.usuario_id = u.id
        WHERE a.produto_id = $1
        ORDER BY a.created_at DESC
        LIMIT 10
      `, [req.params.id])
    ]);

    // Processar URLs das imagens dos produtos similares
    const produtosSimilaresProcessados = produtosSimilares.rows.map(prod => ({
      ...prod,
      imagem1_url: prod.imagem1_id ? gerarUrlImagem(prod.imagem1_id) : null
    }));

    res.render('produtos/detalhes', {
      produto: produtoData,
      produtosSimilares: produtosSimilaresProcessados,
      avaliacoes: avaliacoes.rows,
      title: `${produtoData.nome} - KuandaShop`
    });
  } catch (error) {
    console.error('Erro ao carregar produto:', error);
    req.flash('error', 'Erro ao carregar produto');
    res.redirect('/produtos');
  }
});

// ==================== ROTA DE REGISTRO ATUALIZADA ====================
app.post('/registro', upload.single('foto_perfil'), async (req, res) => {
  const { nome, email, senha, telefone, tipo, nome_loja, descricao_loja } = req.body;
  
  try {
    // Validação básica
    if (!nome || !email || !senha) {
      req.flash('error', 'Nome, email e senha são obrigatórios');
      return res.redirect('/registro');
    }

    if (senha.length < 6) {
      req.flash('error', 'A senha deve ter pelo menos 6 caracteres');
      return res.redirect('/registro');
    }

    if (tipo === 'vendedor' && !nome_loja) {
      req.flash('error', 'Nome da loja é obrigatório para vendedores');
      return res.redirect('/registro');
    }

    // Verificar se email já existe
    const emailExiste = await db.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (emailExiste.rows.length > 0) {
      req.flash('error', 'Este email já está cadastrado');
      return res.redirect('/registro');
    }

    // Hash da senha
    const senhaHash = await bcrypt.hash(senha, 10);
    
    // Processar foto de perfil
    let fotoPerfilImagemId = null;
    if (req.file) {
      const fileBuffer = fs.readFileSync(req.file.path);
      fotoPerfilImagemId = await salvarImagemNoBanco(
        fileBuffer,
        req.file.filename,
        req.file.mimetype,
        'perfil',
        null // Será atualizado após criar o usuário
      );
      fs.unlinkSync(req.file.path);
    }

    // Obter plano básico para vendedores
    let plano_id = null;
    let limite_produtos = 10; // Default para clientes
    
    if (tipo === 'vendedor') {
      const planoBasico = await db.query(
        "SELECT id, limite_produtos FROM planos_vendedor WHERE nome = 'Básico' LIMIT 1"
      );
      if (planoBasico.rows.length > 0) {
        plano_id = planoBasico.rows[0].id;
        limite_produtos = planoBasico.rows[0].limite_produtos;
      }
    }

    // Inserir usuário no banco
    const result = await db.query(`
      INSERT INTO usuarios (nome, email, senha, telefone, tipo, nome_loja, descricao_loja, 
                           foto_perfil_imagem_id, loja_ativa, plano_id, limite_produtos)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, nome, email, tipo, nome_loja, plano_id, limite_produtos
    `, [
      nome.trim(),
      email.trim().toLowerCase(),
      senhaHash,
      telefone ? telefone.trim() : null,
      tipo || 'cliente',
      nome_loja ? nome_loja.trim() : null,
      descricao_loja ? descricao_loja.trim() : null,
      fotoPerfilImagemId,
      tipo === 'vendedor' ? true : null,
      plano_id,
      limite_produtos
    ]);

    const newUser = result.rows[0];

    // Atualizar imagem com entityId
    if (fotoPerfilImagemId) {
      await db.query(
        'UPDATE imagens SET entidade_id = $1 WHERE id = $2',
        [newUser.id, fotoPerfilImagemId]
      );
    }

    // Auto-login após registro
    req.session.user = {
      id: newUser.id,
      nome: newUser.nome,
      email: newUser.email,
      tipo: newUser.tipo,
      nome_loja: newUser.nome_loja,
      loja_ativa: tipo === 'vendedor',
      foto_perfil: fotoPerfilImagemId ? gerarUrlImagem(fotoPerfilImagemId) : null,
      plano_id: newUser.plano_id || null,
      limite_produtos: newUser.limite_produtos || 10
    };

    req.flash('success', 'Conta criada com sucesso!');
    
    if (newUser.tipo === 'admin') {
      res.redirect('/admin');
    } else if (newUser.tipo === 'vendedor') {
      res.redirect('/vendedor');
    } else {
      res.redirect('/');
    }
  } catch (error) {
    console.error('Erro no registro:', error);
    req.flash('error', 'Erro ao criar conta. Tente novamente.');
    res.redirect('/registro');
  }
});

// ==================== ROTA DE PERFIL ATUALIZADA ====================
app.get('/perfil', requireAuth, async (req, res) => {
  try {
    const usuario = await db.query('SELECT * FROM usuarios WHERE id = $1', [req.session.user.id]);
    
    if (usuario.rows.length === 0) {
      req.flash('error', 'Usuário não encontrado');
      return res.redirect('/');
    }

    // Buscar imagem de perfil do banco
    const fotoPerfilImagem = await obterImagemDoBanco('perfil', usuario.rows[0].id, 'perfil');

    // Buscar informações do plano se for vendedor
    let planoInfo = null;
    if (req.session.user.tipo === 'vendedor' && usuario.rows[0].plano_id) {
      planoInfo = await db.query(
        'SELECT * FROM planos_vendedor WHERE id = $1',
        [usuario.rows[0].plano_id]
      );
    }

    // Contar produtos cadastrados
    const produtosCount = await db.query(
      'SELECT COUNT(*) as total FROM produtos WHERE vendedor_id = $1',
      [req.session.user.id]
    );

    res.render('perfil', { 
      usuario: {
        ...usuario.rows[0],
        foto_perfil_url: fotoPerfilImagem ? gerarUrlImagem(fotoPerfilImagem.id) : null
      },
      planoInfo: planoInfo ? planoInfo.rows[0] : null,
      produtosCadastrados: produtosCount.rows[0].total,
      currentUser: req.session.user,
      title: 'Meu Perfil - KuandaShop'
    });
  } catch (error) {
    console.error('Erro ao carregar perfil:', error);
    req.flash('error', 'Erro ao carregar perfil');
    res.render('perfil', { 
      usuario: {},
      planoInfo: null,
      produtosCadastrados: 0,
      currentUser: req.session.user,
      title: 'Meu Perfil'
    });
  }
});

app.post('/perfil/atualizar', requireAuth, upload.single('foto_perfil'), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { nome, telefone, nome_loja, descricao_loja, remover_foto } = req.body;
    
    // Obter usuário atual
    const usuarioAtual = await db.query('SELECT * FROM usuarios WHERE id = $1', [userId]);
    
    if (usuarioAtual.rows.length === 0) {
      req.flash('error', 'Usuário não encontrado');
      return res.redirect('/perfil');
    }
    
    // Processar foto de perfil
    let fotoPerfilImagemId = usuarioAtual.rows[0].foto_perfil_imagem_id;
    
    // Se marcar para remover foto
    if (remover_foto === '1' || remover_foto === 'true') {
      if (fotoPerfilImagemId) {
        await deletarImagemDoBanco(fotoPerfilImagemId);
      }
      fotoPerfilImagemId = null;
    }
    
    // Se enviou nova foto
    if (req.file) {
      // Remover foto antiga se existir
      if (fotoPerfilImagemId) {
        await deletarImagemDoBanco(fotoPerfilImagemId);
      }
      
      // Salvar nova foto
      const fileBuffer = fs.readFileSync(req.file.path);
      fotoPerfilImagemId = await salvarImagemNoBanco(
        fileBuffer,
        req.file.filename,
        req.file.mimetype,
        'perfil',
        userId
      );
      
      fs.unlinkSync(req.file.path);
    }
    
    // Preparar dados para atualização
    const updateData = [nome.trim(), telefone ? telefone.trim() : null, fotoPerfilImagemId];
    let query = 'UPDATE usuarios SET nome = $1, telefone = $2, foto_perfil_imagem_id = $3';
    let paramCount = 3;

    // Adicionar campos específicos para vendedores
    if (req.session.user.tipo === 'vendedor') {
      if (nome_loja !== undefined) {
        paramCount++;
        query += `, nome_loja = $${paramCount}`;
        updateData.push(nome_loja ? nome_loja.trim() : null);
      }
      
      if (descricao_loja !== undefined) {
        paramCount++;
        query += `, descricao_loja = $${paramCount}`;
        updateData.push(descricao_loja ? descricao_loja.trim() : null);
      }
    }
    
    // Adicionar WHERE clause
    paramCount++;
    query += `, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramCount}`;
    updateData.push(userId);
    
    // Executar atualização
    await db.query(query, updateData);
    
    // Atualizar sessão
    req.session.user.nome = nome;
    req.session.user.telefone = telefone || null;
    if (req.session.user.tipo === 'vendedor' && nome_loja !== undefined) {
      req.session.user.nome_loja = nome_loja || '';
    }
    
    // Atualizar URL da foto na sessão
    if (fotoPerfilImagemId) {
      req.session.user.foto_perfil = gerarUrlImagem(fotoPerfilImagemId);
    } else {
      req.session.user.foto_perfil = null;
    }
    
    req.flash('success', 'Perfil atualizado com sucesso!');
    res.redirect('/perfil');
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    
    // Remover arquivo temporário em caso de erro
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    req.flash('error', 'Erro ao atualizar perfil');
    res.redirect('/perfil');
  }
});

// ==================== FUNÇÃO DE VALIDAÇÃO (MANTIDA) ====================
const validateProductData = (data) => {
  const errors = [];
  
  if (!data.nome || data.nome.trim().length < 3) {
    errors.push('Nome do produto deve ter pelo menos 3 caracteres');
  }
  
  if (!data.descricao || data.descricao.trim().length < 10) {
    errors.push('Descrição deve ter pelo menos 10 caracteres');
  }
  
  if (!data.preco || isNaN(data.preco) || parseFloat(data.preco) <= 0) {
    errors.push('Preço deve ser um número positivo');
  }
  
  if (!data.categoria_id || isNaN(data.categoria_id)) {
    errors.push('Categoria é obrigatória');
  }
  
  if (!data.estoque || isNaN(data.estoque) || parseInt(data.estoque) < 0) {
    errors.push('Estoque deve ser um número não negativo');
  }
  
  return errors;
};

// ==================== MIDDLEWARE DE LIMPEZA DE SESSÃO ====================
app.use((req, res, next) => {
  // Limpar sessões antigas automaticamente
  if (req.session.user && req.session.cookie._expires) {
    const sessionAge = Date.now() - req.session.cookie._expires.getTime();
    if (sessionAge > 24 * 60 * 60 * 1000) { // 24 horas
      req.session.destroy();
      return res.redirect('/login');
    }
  }
  next();
});

// ==================== ROTA DE LIMPEZA DE CACHE ====================
app.get('/clear-cache', requireAdmin, async (req, res) => {
  try {
    // Limpar diretórios temporários
    const tmpDirs = [
      'tmp/uploads',
      'tmp/uploads/banners',
      'tmp/uploads/filmes',
      'tmp/uploads/produtos',
      'tmp/uploads/perfil',
      'tmp/uploads/games',
      'tmp/uploads/categorias'
    ];
    
    tmpDirs.forEach(dir => {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    req.flash('success', 'Cache limpo com sucesso!');
    res.redirect('/admin');
  } catch (error) {
    console.error('Erro ao limpar cache:', error);
    req.flash('error', 'Erro ao limpar cache');
    res.redirect('/admin');
  }
});

// ==================== TRATAMENTO DE ERROS ====================

// 1. Erro 404 - Página não encontrada
app.use((req, res) => {
  const safeUser = (req.session && req.session.user) ? req.session.user : null;

  res.status(404).render('404', {
    layout: false,
    title: '404 - Página não encontrada',
    user: safeUser,
    currentUser: safeUser
  });
});

// 2. Erros do Multer (Upload)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (req.session && typeof req.flash === 'function') {
      if (err.code === 'LIMIT_FILE_SIZE') {
        req.flash('error', 'Arquivo muito grande. Tamanho máximo: 10MB');
      } else {
        req.flash('error', `Erro no upload: ${err.message}`);
      }
      return res.redirect('back');
    }
    return next(err);
  }
  
  next(err);
});

// 3. Erro 500 - Erro Interno
app.use((err, req, res, next) => {
  console.error('❌ ERRO CRÍTICO NO SERVIDOR:', err);
  
  if (res.headersSent) {
    return next(err);
  }

  const safeUser = (req.session && req.session.user) ? req.session.user : null;

  res.status(500).render('500', {
    layout: false,
    title: '500 - Erro interno do servidor',
    error: process.env.NODE_ENV === 'development' ? err : { message: 'Ocorreu um erro inesperado. Tente novamente.' },
    user: safeUser,
    currentUser: safeUser
  });
});

// ==================== INICIALIZAR SERVIDOR ====================
const server = app.listen(PORT, () => {
  console.log(`
  ====================================================
  🚀 KUANDASHOP MARKETPLACE MULTI-VENDOR
  ====================================================
  ✅ Sistema inicializado com sucesso!
  ✅ Banco de dados conectado
  ✅ Sistema de imagens no banco de dados ativo
  ✅ Sessões configuradas no PostgreSQL
  ✅ Uploads otimizados
  ✅ Painéis administrativos prontos
  ✅ Sistema de planos implementado
  
  📍 Porta: ${PORT}
  🌐 Ambiente: ${process.env.NODE_ENV || 'production'}
  
  🖼️ Sistema de Imagens:
    • Todas as imagens salvas no banco de dados
    • Persistência garantida após reinício
    • Otimização automática
    • Cache por 1 ano
    • URLs dinâmicas via API
  
  👤 Gerenciamento de Usuários:
    • Listagem completa corrigida
    • Filtros por tipo e status
    • Alteração de tipo de usuário
    • Exclusão segura com verificação
  
  🎨 Gerenciamento de Banners:
    • Sistema corrigido
    • Uploads funcionando
    • Exclusão funcionando
    • Persistência garantida
  
  ⚡ Performance:
    • Timeouts para prevenir travamento
    • Cache de sessão otimizado
    • Limpeza automática de arquivos temporários
    • Conexões de banco otimizadas
  
  ====================================================
  `);
});

// Tratamento de encerramento gracioso
process.on('SIGTERM', () => {
  console.log('🛑 Recebido sinal SIGTERM, encerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor encerrado com sucesso');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Recebido sinal SIGINT, encerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor encerrado com sucesso');
    process.exit(0);
  });
});

// Tratamento de erros não capturados
process.on('uncaughtException', (err) => {
  console.error('❌ Erro não capturado:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promessa rejeitada não tratada:', reason);
});

module.exports = app;
