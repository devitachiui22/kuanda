const fs = require('fs');
const path = require('path');

// Pastas que precisam ser criadas
const folders = [
  'public/uploads',
  'public/uploads/banners',
  'public/uploads/filmes',
  'public/uploads/produtos',
  'public/uploads/perfis'
];

console.log('📁 Criando pastas necessárias...');

folders.forEach(folder => {
  const folderPath = path.join(__dirname, folder);
  
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
    console.log(`✅ Criada: ${folder}`);
  } else {
    console.log(`✓ Já existe: ${folder}`);
  }
});

console.log('✅ Todas as pastas foram criadas/verificadas!');