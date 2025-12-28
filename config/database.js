const { Pool } = require('pg');
require('dotenv').config(); // ADICIONAR

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_M4JBtEeqFaG1@ep-old-mouse-abonaj64-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require',
  ssl: {
    rejectUnauthorized: false
  }
});

// Função para executar queries
const query = (text, params) => {
  return pool.query(text, params);
};

// Função para verificar se o banco precisa ser inicializado
const initDatabase = async () => {
  try {
    console.log('🔄 Verificando banco de dados...');
    
    // Verificar se a tabela de usuários existe
    const tablesExist = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'usuarios'
      )
    `);

    if (!tablesExist.rows[0].exists) {
      console.log('⚠️ Banco não inicializado. Executando script SQL...');
      
      // Criar tabela de usuários
      await query(`
        CREATE TABLE usuarios (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(255) NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          senha VARCHAR(255) NOT NULL,
          telefone VARCHAR(20),
          tipo VARCHAR(20) DEFAULT 'cliente' CHECK (tipo IN ('cliente', 'vendedor', 'admin')),
          nome_loja VARCHAR(255),
          descricao_loja TEXT,
          foto_perfil VARCHAR(255),
          banner_loja VARCHAR(255),
          loja_ativa BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Criar tabela de categorias
      await query(`
        CREATE TABLE categorias (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(255) NOT NULL,
          icone VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Criar tabela de produtos
      await query(`
        CREATE TABLE produtos (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(255) NOT NULL,
          descricao TEXT,
          preco DECIMAL(10,2) NOT NULL,
          preco_promocional DECIMAL(10,2),
          categoria_id INTEGER REFERENCES categorias(id),
          vendedor_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
          imagem1 VARCHAR(255),
          imagem2 VARCHAR(255),
          imagem3 VARCHAR(255),
          estoque INTEGER DEFAULT 0,
          ativo BOOLEAN DEFAULT true,
          destaque BOOLEAN DEFAULT false,
          vip BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Criar tabela de banners
      await query(`
        CREATE TABLE banners (
          id SERIAL PRIMARY KEY,
          titulo VARCHAR(255),
          imagem VARCHAR(255) NOT NULL,
          link VARCHAR(255),
          ordem INTEGER DEFAULT 0,
          ativo BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Criar tabela de filmes
      await query(`
        CREATE TABLE filmes (
          id SERIAL PRIMARY KEY,
          titulo VARCHAR(255) NOT NULL,
          poster VARCHAR(255),
          trailer_url VARCHAR(255),
          sinopse TEXT,
          data_lancamento DATE,
          classificacao VARCHAR(10),
          ativo BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Criar tabela de seguidores
      await query(`
        CREATE TABLE seguidores (
          id SERIAL PRIMARY KEY,
          usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
          loja_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(usuario_id, loja_id)
        )
      `);

      // Criar tabela de avaliações
      await query(`
        CREATE TABLE avaliacoes (
          id SERIAL PRIMARY KEY,
          produto_id INTEGER REFERENCES produtos(id) ON DELETE CASCADE,
          usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
          classificacao INTEGER CHECK (classificacao >= 1 AND classificacao <= 5),
          comentario TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Criar tabela de solicitações VIP
      await query(`
        CREATE TABLE solicitacoes_vip (
          id SERIAL PRIMARY KEY,
          produto_id INTEGER REFERENCES produtos(id) ON DELETE CASCADE,
          vendedor_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
          tipo VARCHAR(20) DEFAULT 'produto' CHECK (tipo IN ('produto', 'banner')),
          status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovada', 'rejeitada')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Criar tabela para configurações do site
      await query(`
        CREATE TABLE configuracoes (
          id SERIAL PRIMARY KEY,
          nome_site VARCHAR(255) DEFAULT 'KuandaShop',
          email_contato VARCHAR(255),
          telefone_contato VARCHAR(20),
          endereco TEXT,
          sobre_nos TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Criar tabela para sessões (NECESSÁRIA para connect-pg-simple)
      await query(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          sid VARCHAR PRIMARY KEY,
          sess JSON NOT NULL,
          expire TIMESTAMP NOT NULL
        );
        
        CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);
      `);

      // Inserir configuração padrão
      await query(`
        INSERT INTO configuracoes (nome_site, email_contato, telefone_contato, sobre_nos) 
        VALUES ('KuandaShop', 'contato@kuandashop.ao', '+244 123 456 789', 'Marketplace multi-vendedor completo')
      `);

      // Inserir usuário administrador padrão
      const adminPassword = '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'; // password
      await query(`
        INSERT INTO usuarios (nome, email, senha, tipo) 
        VALUES ('Administrador', 'admin@kuandashop.ao', $1, 'admin')
      `, [adminPassword]);

      // Inserir categorias padrão
      const categorias = [
        'Eletrônicos', 'Moda e Vestuário', 'Casa e Jardim', 'Esportes e Lazer',
        'Beleza e Cuidados', 'Livros e Educação', 'Automóveis', 'Alimentação',
        'Saúde e Bem-estar', 'Brinquedos e Jogos', 'Música e Instrumentos', 'Arte e Artesanato',
        'Arrendamento', 'Aluger', 'Jogos de PC', 'Jogos de Video Game',
        'Serviços freelancer', 'Ferramentas e Equipamentos', 'Joias e Acessórios', 'Produtos para Animais'
      ];

      for (const categoria of categorias) {
        await query('INSERT INTO categorias (nome) VALUES ($1)', [categoria]);
      }

      console.log('✅ Banco de dados inicializado com sucesso!');
      console.log('👤 Admin criado: admin@kuandashop.ao / password');
    } else {
      console.log('✅ Banco de dados já está inicializado.');
    }
    
  } catch (error) {
    console.error('❌ Erro ao verificar/incializar banco de dados:', error.message);
    console.error('Stack:', error.stack);
  }
};

// Inicializar banco na primeira execução
initDatabase().catch(console.error);

module.exports = { query, pool };