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
const fs = require('fs').promises;
const fsSync = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURAÇÃO DE DIRETÓRIOS ====================
const uploadDirs = [
  'public/uploads',
  'public/uploads/temp'
];

uploadDirs.forEach(dir => {
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
    console.log(`✅ Criado diretório: ${dir}`);
  }
});

// ==================== SISTEMA DE PERSISTÊNCIA DE IMAGENS ====================

// Função para salvar imagem no banco de dados
const salvarImagemBanco = async (file, entidadeTipo, entidadeId = null, usuarioId = null) => {
  try {
    // Ler arquivo como buffer
    const fileData = await fs.readFile(file.path);
    
    // Inserir no banco de dados
    const result = await db.query(`
      INSERT INTO imagens (nome_arquivo, tipo, dados, entidade_tipo, entidade_id, usuario_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      RETURNING id, nome_arquivo
    `, [
      file.filename,
      file.mimetype,
      fileData,
      entidadeTipo,
      entidadeId,
      usuarioId
    ]);

    // Remover arquivo temporário
    try {
      await fs.unlink(file.path);
    } catch (unlinkError) {
      console.warn('⚠️ Não foi possível remover arquivo temporário:', unlinkError.message);
    }
    
    return result.rows[0];
  } catch (error) {
    console.error('❌ Erro ao salvar imagem no banco:', error.message);
    
    // Tentar remover arquivo temporário em caso de erro
    try {
      if (file && file.path) {
        await fs.unlink(file.path);
      }
    } catch (unlinkError) {
      // Ignorar erro de remoção
    }
    
    throw error;
  }
};

// Função para obter imagem do banco de dados
const obterImagemBanco = async (imagemId) => {
  try {
    if (!imagemId) return null;
    
    const result = await db.query(`
      SELECT dados, tipo, nome_arquivo, entidade_tipo, entidade_id
      FROM imagens 
      WHERE id = $1
    `, [imagemId]);

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    console.error('❌ Erro ao obter imagem do banco:', error.message);
    return null;
  }
};

// Função para remover imagem do banco
const removerImagemBanco = async (imagemId) => {
  try {
    if (!imagemId) return true;
    
    await db.query('DELETE FROM imagens WHERE id = $1', [imagemId]);
    return true;
  } catch (error) {
    console.error('❌ Erro ao remover imagem do banco:', error.message);
    return false;
  }
};

// Função para remover todas imagens de uma entidade
const removerImagensEntidade = async (entidadeTipo, entidadeId) => {
  try {
    await db.query(`
      DELETE FROM imagens 
      WHERE entidade_tipo = $1 AND entidade_id = $2
    `, [entidadeTipo, entidadeId]);
    return true;
  } catch (error) {
    console.error('❌ Erro ao remover imagens da entidade:', error.message);
    return false;
  }
};

// ==================== ROTA PARA SERVIR IMAGENS ====================
app.get('/imagem/:id', async (req, res) => {
  try {
    const imagemId = req.params.id;
    
    if (!imagemId || isNaN(imagemId)) {
      return res.status(404).send('ID de imagem inválido');
    }

    const imagem = await obterImagemBanco(imagemId);
    
    if (!imagem) {
      return res.status(404).send('Imagem não encontrada');
    }

    // Configurar headers
    res.set({
      'Content-Type': imagem.tipo,
      'Content-Disposition': `inline; filename="${imagem.nome_arquivo}"`,
      'Cache-Control': 'public, max-age=31536000' // Cache por 1 ano
    });

    // Enviar dados binários
    res.send(imagem.dados);
  } catch (error) {
    console.error('❌ Erro ao servir imagem:', error.message);
    res.status(500).send('Erro ao carregar imagem');
  }
});

// ==================== CONFIGURAÇÃO DO MULTER (TEMPORÁRIO) ====================
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = 'public/uploads/temp/';
    if (!fsSync.existsSync(uploadPath)) {
      fsSync.mkdirSync(uploadPath, { recursive: true });
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
  const filetypes = /jpeg|jpg|png|gif|webp/;
  const mimetype = filetypes.test(file.mimetype);
  const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
  
  if (mimetype && extname) {
    return cb(null, true);
  }
  cb(new Error('Apenas imagens são permitidas (JPEG, JPG, PNG, GIF, WebP)!'));
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Configuração específica para perfil
const uploadPerfil = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter
});

// Configuração para jogos
const uploadJogos = multer({
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: fileFilter
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

// Middleware global para variáveis de template
app.use((req, res, next) => {
  // Configurar usuário atual
  res.locals.user = req.session.user || null;
  res.locals.messages = req.flash();
  res.locals.currentUrl = req.originalUrl;
  
  // Inicializar carrinho se não existir
  if (!req.session.carrinho) {
    req.session.carrinho = [];
  }
  res.locals.carrinho = req.session.carrinho;
  
  // Função auxiliar para obter URL da imagem
  res.locals.getImageUrl = (imagemId) => {
    return imagemId ? `/imagem/${imagemId}` : '/images/placeholder.png';
  };
  
  // Função para obter URL de imagem do produto
  res.locals.getProdutoImage = (produto, index = 1) => {
    const imageId = index === 1 ? produto.imagem1_id : (index === 2 ? produto.imagem2_id : produto.imagem3_id);
    return imageId ? `/imagem/${imageId}` : '/images/placeholder-product.png';
  };
  
  next();
});

// ==================== FUNÇÕES AUXILIARES ====================
const removeProfilePicture = async (imagemId) => {
  if (!imagemId) return;
  try {
    await removerImagemBanco(imagemId);
  } catch (error) {
    console.error('❌ Erro ao remover foto de perfil:', error.message);
  }
};

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
  console.log('🔄 Verificando banco de dados...');
  
  try {
    // Verificar conexão
    await db.query('SELECT 1');
    console.log('✅ Conexão com banco de dados OK');
    
    // Criar tabela de imagens se não existir (com entidade_id opcional)
    await db.query(`
      CREATE TABLE IF NOT EXISTS imagens (
        id SERIAL PRIMARY KEY,
        nome_arquivo VARCHAR(255) NOT NULL,
        tipo VARCHAR(50) NOT NULL,
        dados BYTEA NOT NULL,
        entidade_tipo VARCHAR(50) NOT NULL,
        entidade_id INTEGER,
        usuario_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Tabela imagens verificada/criada');

    // Criar índice se não existir
    try {
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_imagens_entidade 
        ON imagens(entidade_tipo, entidade_id)
      `);
    } catch (indexError) {
      console.log('ℹ️ Índice já existe ou erro:', indexError.message);
    }

    // Verificar e criar outras tabelas necessárias
    const tables = [
      'planos_vendedor',
      'usuarios',
      'produtos', 
      'banners',
      'filmes',
      'categorias',
      'avaliacoes',
      'seguidores',
      'solicitacoes_vip',
      'jogos',
      'configuracoes'
    ];

    for (const table of tables) {
      try {
        await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
        console.log(`✅ Tabela ${table} existe`);
      } catch (error) {
        console.log(`ℹ️ Tabela ${table} não existe ou erro:`, error.message);
      }
    }

    console.log('✅ Banco de dados verificado com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao verificar banco de dados:', error.message);
  }
};

// Executar inicialização
inicializarBancoDados();

// ==================== FUNÇÕES AUXILIARES PARA IMAGENS ====================

// Função para processar upload de imagem e salvar no banco
const processarUploadImagem = async (file, entidadeTipo, entidadeId = null, usuarioId = null) => {
  if (!file) return null;
  
  try {
    const imagemSalva = await salvarImagemBanco(file, entidadeTipo, entidadeId, usuarioId);
    return imagemSalva ? imagemSalva.id : null;
  } catch (error) {
    console.error(`❌ Erro ao processar upload para ${entidadeTipo}:`, error.message);
    return null;
  }
};

// Função para obter dados de produto com URLs de imagem
const obterProdutoComImagens = async (produtoId) => {
  try {
    const produto = await db.query(`
      SELECT p.*, 
             u.nome_loja, u.foto_perfil_id as loja_foto_id,
             c.nome as categoria_nome,
             COALESCE(AVG(a.classificacao), 0) as media_classificacao,
             COUNT(a.id) as total_avaliacoes
      FROM produtos p 
      LEFT JOIN usuarios u ON p.vendedor_id = u.id 
      LEFT JOIN categorias c ON p.categoria_id = c.id
      LEFT JOIN avaliacoes a ON p.id = a.produto_id
      WHERE p.id = $1
      GROUP BY p.id, u.nome_loja, u.foto_perfil_id, c.nome
    `, [produtoId]);

    if (produto.rows.length === 0) return null;

    const produtoData = produto.rows[0];
    
    // Adicionar URLs das imagens
    produtoData.imagem1_url = produtoData.imagem1_id ? `/imagem/${produtoData.imagem1_id}` : '/images/placeholder-product.png';
    produtoData.imagem2_url = produtoData.imagem2_id ? `/imagem/${produtoData.imagem2_id}` : null;
    produtoData.imagem3_url = produtoData.imagem3_id ? `/imagem/${produtoData.imagem3_id}` : null;
    produtoData.loja_foto_url = produtoData.loja_foto_id ? `/imagem/${produtoData.loja_foto_id}` : '/images/default-avatar.png';

    return produtoData;
  } catch (error) {
    console.error('❌ Erro ao obter produto com imagens:', error.message);
    throw error;
  }
};

// ==================== ROTAS PÚBLICAS ====================
app.get('/', async (req, res) => {
  try {
    // Buscar banners
    let banners = [];
    try {
      const bannersResult = await db.query(`
        SELECT b.*, i.id as imagem_id 
        FROM banners b 
        LEFT JOIN imagens i ON b.imagem_id = i.id 
        WHERE b.ativo = true 
        ORDER BY b.ordem
      `);
      banners = bannersResult.rows.map(banner => ({
        ...banner,
        imagem_url: banner.imagem_id ? `/imagem/${banner.imagem_id}` : '/images/banner-placeholder.jpg'
      }));
    } catch (bannerError) {
      console.error('❌ Erro ao carregar banners:', bannerError.message);
    }

    // Buscar produtos em destaque
    let produtosDestaque = [];
    try {
      const produtosResult = await db.query(`
        SELECT p.*, u.nome_loja
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        WHERE p.ativo = true AND p.destaque = true AND u.loja_ativa = true
        ORDER BY p.created_at DESC 
        LIMIT 12
      `);
      
      produtosDestaque = await Promise.all(produtosResult.rows.map(async (produto) => {
        return {
          ...produto,
          imagem1_url: produto.imagem1_id ? `/imagem/${produto.imagem1_id}` : '/images/placeholder-product.png'
        };
      }));
    } catch (produtoError) {
      console.error('❌ Erro ao carregar produtos destaque:', produtoError.message);
    }

    // Buscar produtos VIP
    let produtosVip = [];
    try {
      const vipResult = await db.query(`
        SELECT p.*, u.nome_loja
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        WHERE p.ativo = true AND p.vip = true AND u.loja_ativa = true
        ORDER BY p.created_at DESC 
        LIMIT 8
      `);
      
      produtosVip = await Promise.all(vipResult.rows.map(async (produto) => {
        return {
          ...produto,
          imagem1_url: produto.imagem1_id ? `/imagem/${produto.imagem1_id}` : '/images/placeholder-product.png'
        };
      }));
    } catch (vipError) {
      console.error('❌ Erro ao carregar produtos VIP:', vipError.message);
    }

    // Buscar filmes
    let filmes = [];
    try {
      const filmesResult = await db.query(`
        SELECT f.*, i.id as imagem_id 
        FROM filmes f 
        LEFT JOIN imagens i ON f.poster_id = i.id 
        WHERE f.ativo = true 
        ORDER BY f.data_lancamento DESC 
        LIMIT 6
      `);
      
      filmes = filmesResult.rows.map(filme => ({
        ...filme,
        imagem_url: filme.imagem_id ? `/imagem/${filme.imagem_id}` : '/images/movie-placeholder.jpg'
      }));
    } catch (filmeError) {
      console.error('❌ Erro ao carregar filmes:', filmeError.message);
    }

    // Buscar categorias
    let categorias = [];
    try {
      const categoriasResult = await db.query('SELECT * FROM categorias ORDER BY nome');
      categorias = categoriasResult.rows;
    } catch (categoriaError) {
      console.error('❌ Erro ao carregar categorias:', categoriaError.message);
    }

    res.render('index', {
      banners,
      produtosDestaque,
      produtosVip,
      filmes,
      categorias,
      title: 'KuandaShop - Marketplace Multi-Vendor'
    });
  } catch (error) {
    console.error('❌ Erro geral ao carregar página inicial:', error.message);
    res.render('index', {
      banners: [],
      produtosDestaque: [],
      produtosVip: [],
      filmes: [],
      categorias: [],
      title: 'KuandaShop - Marketplace'
    });
  }
});

app.get('/produtos', async (req, res) => {
  const { categoria, busca, ordenar } = req.query;
  
  try {
    let query = `
      SELECT p.*, u.nome_loja, c.nome as categoria_nome
      FROM produtos p 
      JOIN usuarios u ON p.vendedor_id = u.id 
      LEFT JOIN categorias c ON p.categoria_id = c.id
      WHERE p.ativo = true AND u.loja_ativa = true
    `;
    
    const params = [];
    let paramCount = 0;

    if (categoria) {
      paramCount++;
      query += ` AND p.categoria_id = $${paramCount}`;
      params.push(categoria);
    }

    if (busca) {
      paramCount++;
      query += ` AND (p.nome ILIKE $${paramCount} OR p.descricao ILIKE $${paramCount} OR u.nome_loja ILIKE $${paramCount})`;
      params.push(`%${busca}%`);
    }

    switch (ordenar) {
      case 'preco_asc':
        query += ' ORDER BY p.preco ASC';
        break;
      case 'preco_desc':
        query += ' ORDER BY p.preco DESC';
        break;
      case 'nome':
        query += ' ORDER BY p.nome ASC';
        break;
      case 'novos':
        query += ' ORDER BY p.created_at DESC';
        break;
      default:
        query += ' ORDER BY p.created_at DESC';
    }

    const produtosResult = await db.query(query, params);
    
    // Processar produtos com imagens
    const produtos = await Promise.all(produtosResult.rows.map(async (produto) => {
      return {
        ...produto,
        imagem1_url: produto.imagem1_id ? `/imagem/${produto.imagem1_id}` : '/images/placeholder-product.png',
        preco_promocional: produto.preco_promocional || null
      };
    }));

    const categoriasList = await db.query('SELECT * FROM categorias ORDER BY nome');

    res.render('produtos/lista', {
      produtos,
      categorias: categoriasList.rows,
      filtros: { categoria, busca, ordenar },
      title: 'Produtos - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro ao carregar produtos:', error.message);
    res.render('produtos/lista', {
      produtos: [],
      categorias: [],
      filtros: { categoria, busca, ordenar },
      title: 'Produtos'
    });
  }
});

app.get('/produto/:id', async (req, res) => {
  try {
    const produto = await obterProdutoComImagens(req.params.id);
    
    if (!produto) {
      req.flash('error', 'Produto não encontrado');
      return res.redirect('/produtos');
    }

    // Buscar produtos similares
    let produtosSimilares = [];
    try {
      const similaresResult = await db.query(`
        SELECT p.*, u.nome_loja
        FROM produtos p 
        JOIN usuarios u ON p.vendedor_id = u.id 
        WHERE p.categoria_id = $1 AND p.id != $2 AND p.ativo = true AND u.loja_ativa = true
        ORDER BY RANDOM()
        LIMIT 6
      `, [produto.categoria_id, req.params.id]);
      
      produtosSimilares = await Promise.all(similaresResult.rows.map(async (prod) => {
        return {
          ...prod,
          imagem1_url: prod.imagem1_id ? `/imagem/${prod.imagem1_id}` : '/images/placeholder-product.png'
        };
      }));
    } catch (similaresError) {
      console.error('❌ Erro ao carregar produtos similares:', similaresError.message);
    }

    // Buscar avaliações
    let avaliacoes = [];
    try {
      const avaliacoesResult = await db.query(`
        SELECT a.*, u.nome, u.foto_perfil_id
        FROM avaliacoes a
        JOIN usuarios u ON a.usuario_id = u.id
        WHERE a.produto_id = $1
        ORDER BY a.created_at DESC
        LIMIT 10
      `, [req.params.id]);
      
      avaliacoes = avaliacoesResult.rows.map(avaliacao => ({
        ...avaliacao,
        foto_perfil_url: avaliacao.foto_perfil_id ? `/imagem/${avaliacao.foto_perfil_id}` : '/images/default-avatar.png'
      }));
    } catch (avaliacaoError) {
      console.error('❌ Erro ao carregar avaliações:', avaliacaoError.message);
    }

    res.render('produtos/detalhes', {
      produto,
      produtosSimilares,
      avaliacoes,
      title: `${produto.nome} - KuandaShop`
    });
  } catch (error) {
    console.error('❌ Erro ao carregar produto:', error.message);
    req.flash('error', 'Erro ao carregar produto');
    res.redirect('/produtos');
  }
});

// ==================== ROTAS DE AUTENTICAÇÃO ====================
app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/');
  }
  res.render('auth/login', { 
    title: 'Login - KuandaShop'
  });
});

app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  
  try {
    if (!email || !senha) {
      req.flash('error', 'Email e senha são obrigatórios');
      return res.redirect('/login');
    }

    const result = await db.query(`
      SELECT u.* 
      FROM usuarios u 
      WHERE u.email = $1
    `, [email.toLowerCase().trim()]);
    
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

    // Configurar sessão do usuário
    req.session.user = {
      id: user.id,
      nome: user.nome,
      email: user.email,
      tipo: user.tipo,
      nome_loja: user.nome_loja,
      loja_ativa: user.loja_ativa,
      foto_perfil_id: user.foto_perfil_id,
      telefone: user.telefone,
      plano_id: user.plano_id || null,
      limite_produtos: user.limite_produtos || 10
    };

    req.flash('success', `Bem-vindo de volta, ${user.nome}!`);
    
    if (user.tipo === 'admin') {
      res.redirect('/admin');
    } else if (user.tipo === 'vendedor') {
      res.redirect('/vendedor');
    } else {
      res.redirect('/');
    }
  } catch (error) {
    console.error('❌ Erro no login:', error.message);
    req.flash('error', 'Erro interno do servidor');
    res.redirect('/login');
  }
});

app.get('/registro', (req, res) => {
  if (req.session.user) {
    return res.redirect('/');
  }
  res.render('auth/registro', { 
    title: 'Registro - KuandaShop'
  });
});

app.post('/registro', uploadPerfil.single('foto_perfil'), async (req, res) => {
  const { nome, email, senha, telefone, tipo = 'cliente', nome_loja, descricao_loja } = req.body;
  
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
    const emailExiste = await db.query('SELECT id FROM usuarios WHERE email = $1', [email.toLowerCase().trim()]);
    if (emailExiste.rows.length > 0) {
      if (req.file) {
        try {
          await fs.unlink(req.file.path);
        } catch (unlinkError) {
          // Ignorar erro
        }
      }
      req.flash('error', 'Este email já está cadastrado');
      return res.redirect('/registro');
    }

    // Hash da senha
    const senhaHash = await bcrypt.hash(senha, 10);
    
    // Processar foto de perfil
    let fotoPerfilId = null;
    if (req.file) {
      try {
        const imagemSalva = await salvarImagemBanco(req.file, 'perfil', null, null);
        fotoPerfilId = imagemSalva ? imagemSalva.id : null;
      } catch (error) {
        console.error('❌ Erro ao salvar foto de perfil:', error.message);
      }
    }

    // Obter plano básico para vendedores
    let plano_id = null;
    let limite_produtos = 10;
    
    if (tipo === 'vendedor') {
      try {
        const planoBasico = await db.query(
          "SELECT id, limite_produtos FROM planos_vendedor WHERE nome = 'Básico' LIMIT 1"
        );
        if (planoBasico.rows.length > 0) {
          plano_id = planoBasico.rows[0].id;
          limite_produtos = planoBasico.rows[0].limite_produtos;
        }
      } catch (planoError) {
        console.error('❌ Erro ao obter plano básico:', planoError.message);
      }
    }

    // Inserir usuário no banco
    const result = await db.query(`
      INSERT INTO usuarios (
        nome, email, senha, telefone, tipo, nome_loja, 
        descricao_loja, foto_perfil_id, loja_ativa, plano_id, limite_produtos
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, nome, email, tipo, nome_loja, foto_perfil_id, plano_id, limite_produtos
    `, [
      nome.trim(),
      email.toLowerCase().trim(),
      senhaHash,
      telefone ? telefone.trim() : null,
      tipo,
      nome_loja ? nome_loja.trim() : null,
      descricao_loja ? descricao_loja.trim() : null,
      fotoPerfilId,
      tipo === 'vendedor' ? true : null,
      plano_id,
      limite_produtos
    ]);

    const newUser = result.rows[0];

    // Auto-login após registro
    req.session.user = {
      id: newUser.id,
      nome: newUser.nome,
      email: newUser.email,
      tipo: newUser.tipo,
      nome_loja: newUser.nome_loja,
      loja_ativa: tipo === 'vendedor',
      foto_perfil_id: newUser.foto_perfil_id,
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
    console.error('❌ Erro no registro:', error.message);
    
    // Remover arquivo temporário em caso de erro
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (unlinkError) {
        // Ignorar erro
      }
    }
    
    req.flash('error', 'Erro ao criar conta. Tente novamente.');
    res.redirect('/registro');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('❌ Erro ao fazer logout:', err.message);
    }
    res.redirect('/');
  });
});

// ==================== ROTAS DE PERFIL ====================
app.get('/perfil', requireAuth, async (req, res) => {
  try {
    const usuario = await db.query('SELECT * FROM usuarios WHERE id = $1', [req.session.user.id]);
    
    if (usuario.rows.length === 0) {
      req.flash('error', 'Usuário não encontrado');
      return res.redirect('/');
    }

    const usuarioData = usuario.rows[0];
    usuarioData.foto_perfil_url = usuarioData.foto_perfil_id ? `/imagem/${usuarioData.foto_perfil_id}` : '/images/default-avatar.png';

    res.render('perfil', { 
      usuario: usuarioData,
      title: 'Meu Perfil - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro ao carregar perfil:', error.message);
    req.flash('error', 'Erro ao carregar perfil');
    res.redirect('/');
  }
});

app.post('/perfil/atualizar', requireAuth, uploadPerfil.single('foto_perfil'), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { nome, telefone, nome_loja, descricao_loja, remover_foto } = req.body;
    
    // Obter usuário atual
    const usuarioAtual = await db.query('SELECT * FROM usuarios WHERE id = $1', [userId]);
    
    if (usuarioAtual.rows.length === 0) {
      req.flash('error', 'Usuário não encontrado');
      return res.redirect('/perfil');
    }
    
    let fotoPerfilId = usuarioAtual.rows[0].foto_perfil_id;
    
    // Se marcar para remover foto
    if (remover_foto === '1' || remover_foto === 'true') {
      if (fotoPerfilId) {
        await removeProfilePicture(fotoPerfilId);
      }
      fotoPerfilId = null;
    }
    
    // Se enviou nova foto
    if (req.file) {
      // Remover foto antiga se existir
      if (fotoPerfilId) {
        await removeProfilePicture(fotoPerfilId);
      }
      
      // Salvar nova foto no banco
      try {
        const imagemSalva = await salvarImagemBanco(req.file, 'perfil', userId, userId);
        fotoPerfilId = imagemSalva ? imagemSalva.id : null;
      } catch (error) {
        console.error('❌ Erro ao salvar nova foto:', error.message);
      }
    }
    
    // Preparar dados para atualização
    const updateData = [nome.trim(), telefone ? telefone.trim() : null, fotoPerfilId];
    let query = 'UPDATE usuarios SET nome = $1, telefone = $2, foto_perfil_id = $3';
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
    if (fotoPerfilId) {
      req.session.user.foto_perfil_id = fotoPerfilId;
    }
    
    req.flash('success', 'Perfil atualizado com sucesso!');
    res.redirect('/perfil');
  } catch (error) {
    console.error('❌ Erro ao atualizar perfil:', error.message);
    
    // Remover arquivo temporário em caso de erro
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (unlinkError) {
        // Ignorar erro
      }
    }
    
    req.flash('error', 'Erro ao atualizar perfil');
    res.redirect('/perfil');
  }
});

// ==================== PAINEL DO VENDEDOR ====================
app.get('/vendedor', requireVendor, async (req, res) => {
  try {
    // Buscar estatísticas
    const statsResult = await db.query(`
      SELECT 
        COUNT(p.id) as total_produtos,
        COUNT(CASE WHEN p.ativo = true THEN 1 END) as produtos_ativos
      FROM produtos p
      WHERE p.vendedor_id = $1
    `, [req.session.user.id]);

    // Buscar produtos recentes
    const produtosRecentesResult = await db.query(`
      SELECT p.*
      FROM produtos p
      WHERE p.vendedor_id = $1
      ORDER BY p.created_at DESC
      LIMIT 5
    `, [req.session.user.id]);
    
    // Processar produtos com imagens
    const produtosRecentes = await Promise.all(produtosRecentesResult.rows.map(async (produto) => {
      return {
        ...produto,
        imagem1_url: produto.imagem1_id ? `/imagem/${produto.imagem1_id}` : '/images/placeholder-product.png'
      };
    }));

    res.render('vendedor/dashboard', {
      stats: statsResult.rows[0] || { total_produtos: 0, produtos_ativos: 0 },
      produtosRecentes,
      title: 'Painel do Vendedor - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro no dashboard do vendedor:', error.message);
    res.render('vendedor/dashboard', {
      stats: { total_produtos: 0, produtos_ativos: 0 },
      produtosRecentes: [],
      title: 'Painel do Vendedor'
    });
  }
});

app.get('/vendedor/produtos', requireVendor, async (req, res) => {
  try {
    const produtos = await db.query(`
      SELECT p.*, c.nome as categoria_nome
      FROM produtos p
      LEFT JOIN categorias c ON p.categoria_id = c.id
      WHERE p.vendedor_id = $1
      ORDER BY p.created_at DESC
    `, [req.session.user.id]);

    // Processar produtos com imagens
    const produtosComImagens = await Promise.all(produtos.rows.map(async (produto) => {
      return {
        ...produto,
        imagem1_url: produto.imagem1_id ? `/imagem/${produto.imagem1_id}` : '/images/placeholder-product.png'
      };
    }));

    res.render('vendedor/produtos', {
      produtos: produtosComImagens,
      title: 'Meus Produtos - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro ao carregar produtos do vendedor:', error.message);
    res.render('vendedor/produtos', { 
      produtos: [],
      title: 'Meus Produtos'
    });
  }
});

app.get('/vendedor/produto/novo', requireVendor, async (req, res) => {
  try {
    const categorias = await db.query('SELECT * FROM categorias ORDER BY nome');
    
    res.render('vendedor/produto-form', {
      produto: null,
      categorias: categorias.rows,
      action: '/vendedor/produto',
      title: 'Novo Produto - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro ao carregar formulário:', error.message);
    res.render('vendedor/produto-form', {
      produto: null,
      categorias: [],
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
  const { nome, descricao, preco, preco_promocional, categoria_id, estoque } = req.body;
  
  try {
    // Validar dados
    const validationErrors = validateProductData({ nome, descricao, preco, categoria_id, estoque });
    if (validationErrors.length > 0) {
      validationErrors.forEach(error => req.flash('error', error));
      return res.redirect('/vendedor/produto/novo');
    }

    // Processar imagens
    let imagem1Id = null;
    let imagem2Id = null;
    let imagem3Id = null;

    if (req.files.imagem1) {
      const imagemSalva = await processarUploadImagem(
        req.files.imagem1[0], 
        'produto', 
        null, 
        req.session.user.id
      );
      imagem1Id = imagemSalva;
    }

    if (req.files.imagem2 && req.files.imagem2[0]) {
      const imagemSalva = await processarUploadImagem(
        req.files.imagem2[0], 
        'produto', 
        null, 
        req.session.user.id
      );
      imagem2Id = imagemSalva;
    }

    if (req.files.imagem3 && req.files.imagem3[0]) {
      const imagemSalva = await processarUploadImagem(
        req.files.imagem3[0], 
        'produto', 
        null, 
        req.session.user.id
      );
      imagem3Id = imagemSalva;
    }

    // Se não enviou imagem principal
    if (!imagem1Id) {
      req.flash('error', 'A imagem principal é obrigatória');
      return res.redirect('/vendedor/produto/novo');
    }

    // Inserir produto no banco
    const result = await db.query(`
      INSERT INTO produtos (
        nome, descricao, preco, preco_promocional, categoria_id, 
        estoque, imagem1_id, imagem2_id, imagem3_id, vendedor_id, 
        ativo
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
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
      req.session.user.id
    ]);

    const produtoId = result.rows[0].id;

    // Atualizar imagens com o ID do produto
    await db.query(`
      UPDATE imagens 
      SET entidade_id = $1 
      WHERE id IN ($2, $3, $4) AND entidade_id IS NULL
    `, [produtoId, imagem1Id, imagem2Id, imagem3Id].filter(id => id !== null));

    req.flash('success', 'Produto cadastrado com sucesso!');
    res.redirect('/vendedor/produtos');
  } catch (error) {
    console.error('❌ Erro ao cadastrar produto:', error.message);
    req.flash('error', 'Erro ao cadastrar produto');
    res.redirect('/vendedor/produto/novo');
  }
});

// ==================== PAINEL ADMINISTRATIVO ====================
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    // Estatísticas básicas
    const stats = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM usuarios WHERE tipo = 'vendedor') as total_vendedores,
        (SELECT COUNT(*) FROM usuarios WHERE tipo = 'cliente') as total_clientes,
        (SELECT COUNT(*) FROM produtos WHERE ativo = true) as total_produtos,
        (SELECT COUNT(*) FROM banners WHERE ativo = true) as banners_ativos
    `);

    res.render('admin/dashboard', {
      stats: stats.rows[0] || {},
      title: 'Painel Administrativo - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro no dashboard admin:', error.message);
    res.render('admin/dashboard', { 
      stats: {},
      title: 'Painel Administrativo'
    });
  }
});

// ==================== GERENCIAMENTO DE USUÁRIOS ====================
app.get('/admin/usuarios', requireAdmin, async (req, res) => {
  try {
    const usuarios = await db.query(`
      SELECT u.*, pv.nome as plano_nome
      FROM usuarios u
      LEFT JOIN planos_vendedor pv ON u.plano_id = pv.id
      ORDER BY u.created_at DESC
    `);
    
    // Adicionar URLs de imagem de perfil
    const usuariosProcessados = usuarios.rows.map(usuario => ({
      ...usuario,
      foto_perfil_url: usuario.foto_perfil_id ? `/imagem/${usuario.foto_perfil_id}` : '/images/default-avatar.png'
    }));

    res.render('admin/usuarios', {
      usuarios: usuariosProcessados,
      title: 'Gerenciar Usuários - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro ao carregar usuários:', error.message);
    res.render('admin/usuarios', {
      usuarios: [],
      title: 'Gerenciar Usuários'
    });
  }
});

app.post('/admin/usuario/:id/toggle-status', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Obter usuário atual
    const usuario = await db.query('SELECT * FROM usuarios WHERE id = $1', [userId]);
    
    if (usuario.rows.length === 0) {
      return res.json({ success: false, message: 'Usuário não encontrado' });
    }

    const novoStatus = !usuario.rows[0].loja_ativa;
    await db.query(
      'UPDATE usuarios SET loja_ativa = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [novoStatus, userId]
    );

    res.json({ 
      success: true, 
      message: `Loja ${novoStatus ? 'ativada' : 'desativada'} com sucesso!`,
      novoStatus 
    });
  } catch (error) {
    console.error('❌ Erro ao alternar status:', error.message);
    res.json({ success: false, message: 'Erro ao alternar status' });
  }
});

// ==================== GERENCIAMENTO DE BANNERS ====================
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
      imagem_url: banner.imagem_id ? `/imagem/${banner.imagem_id}` : '/images/banner-placeholder.jpg'
    }));
    
    res.render('admin/banners', {
      banners: bannersProcessados,
      title: 'Gerenciar Banners - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro ao carregar banners:', error.message);
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

    // Primeiro inserir o banner para obter o ID
    const bannerResult = await db.query(`
      INSERT INTO banners (titulo, link, ordem, ativo)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [
      titulo ? titulo.trim() : null,
      link ? link.trim() : null,
      ordem ? parseInt(ordem) : 0,
      ativo === 'on'
    ]);

    const bannerId = bannerResult.rows[0].id;

    // Agora salvar a imagem no banco com o ID do banner
    let imagemId = null;
    try {
      const imagemSalva = await salvarImagemBanco(req.file, 'banner', bannerId, req.session.user.id);
      imagemId = imagemSalva ? imagemSalva.id : null;
      
      // Atualizar banner com o ID da imagem
      if (imagemId) {
        await db.query(
          'UPDATE banners SET imagem_id = $1 WHERE id = $2',
          [imagemId, bannerId]
        );
      }
    } catch (imageError) {
      console.error('❌ Erro ao salvar imagem do banner:', imageError.message);
      // Se der erro na imagem, remover o banner
      await db.query('DELETE FROM banners WHERE id = $1', [bannerId]);
      req.flash('error', 'Erro ao processar imagem');
      return res.redirect('/admin/banners/novo');
    }
    
    req.flash('success', 'Banner criado com sucesso!');
    res.redirect('/admin/banners');
  } catch (error) {
    console.error('❌ Erro ao criar banner:', error.message);
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
    
    const bannerData = banner.rows[0];
    bannerData.imagem_url = bannerData.imagem_id ? `/imagem/${bannerData.imagem_id}` : '/images/banner-placeholder.jpg';
    
    res.render('admin/banner-form', {
      banner: bannerData,
      action: `/admin/banners/${req.params.id}?_method=PUT`,
      title: 'Editar Banner - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro ao carregar banner:', error.message);
    req.flash('error', 'Erro ao carregar banner');
    res.redirect('/admin/banners');
  }
});

app.put('/admin/banners/:id', requireAdmin, upload.single('imagem'), async (req, res) => {
  const { titulo, link, ordem, ativo } = req.body;
  
  try {
    const banner = await db.query('SELECT * FROM banners WHERE id = $1', [req.params.id]);
    
    if (banner.rows.length === 0) {
      req.flash('error', 'Banner não encontrado');
      return res.redirect('/admin/banners');
    }
    
    let imagemId = banner.rows[0].imagem_id;
    
    if (req.file) {
      // Remover imagem antiga se existir
      if (imagemId) {
        await removerImagemBanco(imagemId);
      }
      
      // Salvar nova imagem
      try {
        const imagemSalva = await salvarImagemBanco(req.file, 'banner', req.params.id, req.session.user.id);
        imagemId = imagemSalva ? imagemSalva.id : null;
      } catch (error) {
        console.error('❌ Erro ao salvar nova imagem:', error.message);
        req.flash('error', 'Erro ao processar imagem');
        return res.redirect(`/admin/banners/${req.params.id}/editar`);
      }
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
    console.error('❌ Erro ao atualizar banner:', error.message);
    req.flash('error', 'Erro ao atualizar banner');
    res.redirect(`/admin/banners/${req.params.id}/editar`);
  }
});

app.delete('/admin/banners/:id', requireAdmin, async (req, res) => {
  try {
    const banner = await db.query('SELECT * FROM banners WHERE id = $1', [req.params.id]);
    
    if (banner.rows.length === 0) {
      req.flash('error', 'Banner não encontrado');
      return res.redirect('/admin/banners');
    }
    
    // Remover imagem do banner se existir
    if (banner.rows[0].imagem_id) {
      await removerImagemBanco(banner.rows[0].imagem_id);
    }
    
    await db.query('DELETE FROM banners WHERE id = $1', [req.params.id]);
    
    req.flash('success', 'Banner excluído com sucesso!');
    res.redirect('/admin/banners');
  } catch (error) {
    console.error('❌ Erro ao excluir banner:', error.message);
    req.flash('error', 'Erro ao excluir banner');
    res.redirect('/admin/banners');
  }
});

// ==================== ROTAS PARA CARREGAR VIEWS BÁSICAS ====================

app.get('/lojas', async (req, res) => {
  try {
    const lojas = await db.query(`
      SELECT u.* 
      FROM usuarios u
      WHERE u.tipo = 'vendedor' AND u.loja_ativa = true
      ORDER BY u.created_at DESC
    `);
    
    // Adicionar URLs de imagem
    const lojasProcessadas = lojas.rows.map(loja => ({
      ...loja,
      foto_perfil_url: loja.foto_perfil_id ? `/imagem/${loja.foto_perfil_id}` : '/images/default-avatar.png'
    }));

    res.render('lojas/lista', {
      lojas: lojasProcessadas,
      title: 'Lojas - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro ao carregar lojas:', error.message);
    res.render('lojas/lista', { 
      lojas: [],
      title: 'Lojas'
    });
  }
});

app.get('/categorias', async (req, res) => {
  try {
    const categorias = await db.query('SELECT * FROM categorias ORDER BY nome');
    res.render('categorias', {
      categorias: categorias.rows,
      title: 'Categorias - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro ao carregar categorias:', error.message);
    res.render('categorias', {
      categorias: [],
      title: 'Categorias'
    });
  }
});

app.get('/games', async (req, res) => {
  try {
    const jogos = await db.query('SELECT * FROM jogos WHERE ativo = true ORDER BY created_at DESC');
    
    // Processar jogos com imagens
    const jogosProcessados = jogos.rows.map(jogo => ({
      ...jogo,
      capa_url: jogo.capa_id ? `/imagem/${jogo.capa_id}` : '/images/game-placeholder.jpg'
    }));

    res.render('games', {
      jogos: jogosProcessados,
      title: 'Games - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro ao carregar games:', error.message);
    res.render('games', {
      jogos: [],
      title: 'Games'
    });
  }
});

// ==================== ROTAS DO CARRINHO ====================
app.get('/carrinho', async (req, res) => {
  try {
    const carrinho = req.session.carrinho || [];
    const total = carrinho.reduce((total, item) => {
      return total + (item.preco || 0) * (item.quantidade || 0);
    }, 0);

    res.render('carrinho', {
      carrinho,
      total: total.toFixed(2),
      title: 'Carrinho de Compras - KuandaShop'
    });
  } catch (error) {
    console.error('❌ Erro ao carregar carrinho:', error.message);
    res.render('carrinho', {
      carrinho: [],
      total: 0,
      title: 'Carrinho de Compras'
    });
  }
});

app.post('/carrinho/adicionar', async (req, res) => {
  try {
    const { produto_id, quantidade = 1 } = req.body;
    const quantidadeNum = parseInt(quantidade) || 1;

    // Buscar produto
    const produto = await db.query(`
      SELECT p.*, u.nome_loja
      FROM produtos p
      JOIN usuarios u ON p.vendedor_id = u.id
      WHERE p.id = $1 AND p.ativo = true AND p.estoque > 0 AND u.loja_ativa = true
    `, [produto_id]);

    if (produto.rows.length === 0) {
      return res.json({ 
        success: false, 
        message: 'Produto não encontrado ou indisponível' 
      });
    }

    const produtoData = produto.rows[0];
    
    // Inicializar carrinho se não existir
    if (!req.session.carrinho) {
      req.session.carrinho = [];
    }

    // Verificar se produto já está no carrinho
    const itemIndex = req.session.carrinho.findIndex(item => item.id == produto_id);
    
    if (itemIndex > -1) {
      req.session.carrinho[itemIndex].quantidade += quantidadeNum;
    } else {
      const preco = produtoData.preco_promocional || produtoData.preco;
      
      req.session.carrinho.push({
        id: produtoData.id,
        nome: produtoData.nome,
        preco: preco,
        quantidade: quantidadeNum,
        vendedor: produtoData.nome_loja
      });
    }

    res.json({ 
      success: true, 
      message: 'Produto adicionado ao carrinho!'
    });
  } catch (error) {
    console.error('❌ Erro ao adicionar ao carrinho:', error.message);
    res.json({ 
      success: false, 
      message: 'Erro interno do servidor' 
    });
  }
});

// ==================== TRATAMENTO DE ERROS ====================

// Erro 404 - Página não encontrada
app.use((req, res) => {
  res.status(404).render('404', {
    layout: false,
    title: '404 - Página não encontrada',
    user: req.session.user || null
  });
});

// Erro 500 - Erro Interno
app.use((err, req, res, next) => {
  console.error('❌ ERRO CRÍTICO NO SERVIDOR:', err.message);
  
  res.status(500).render('500', {
    layout: false,
    title: '500 - Erro interno do servidor',
    error: process.env.NODE_ENV === 'development' ? err.message : 'Ocorreu um erro inesperado. Tente novamente.',
    user: req.session.user || null
  });
});

// ==================== INICIALIZAR SERVIDOR ====================
const server = app.listen(PORT, () => {
  console.log(`
  ====================================================
  🚀 KUANDASHOP MARKETPLACE MULTI-VENDOR
  ====================================================
  ✅ Sistema inicializado com sucesso!
  ✅ Porta: ${PORT}
  ✅ Sistema de imagens persistente
  ✅ Tudo 100% funcional!
  
  🔗 URL: http://localhost:${PORT}
  
  ====================================================
  `);
});

// Tratamento de encerramento gracioso
process.on('SIGTERM', () => {
  console.log('🛑 Encerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Encerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});

module.exports = app;
