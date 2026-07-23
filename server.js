require("dotenv").config();

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const cors = require("cors");
const { Payment } = require("mercadopago");
const { Resend } = require("resend");
const { MercadoPagoConfig, Preference } = require("mercadopago");

const resend = new Resend(process.env.RESEND_API_KEY);

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const app = express();

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const bloqueados = [
    "/server.js",
    "/package.json",
    "/package-lock.json",
    "/.env",
    "/.gitignore"
  ];

  if (bloqueados.includes(req.path)) {
    return res.sendStatus(404);
  }

  next();
});

app.use(express.static(__dirname));


app.post("/crear-preferencia", async (req, res) => {
  try {
    const { cliente, items } = req.body;

    if (!cliente || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Datos inválidos" });
    }

    const {
  nombre,
  apellido,
  email,
  telefono,
  dni,
  entrega,
  direccion,
  depto,
  ciudad,
  provincia,
  cp
} = cliente;

    if (
  !nombre ||
  !apellido ||
  !email ||
  !telefono ||
  !dni ||
  !entrega ||
  !direccion ||
  !ciudad ||
  !provincia ||
  !cp
) {
      return res.status(400).json({ error: "Faltan datos del cliente o facturación" });
    }

    const provinciasBasValidas = [
  "901", "902", "903", "904", "905", "906",
  "907", "908", "909", "910", "911", "912",
  "913", "914", "915", "916", "917", "918",
  "919", "920", "921", "922", "923", "924"
];

if (!provinciasBasValidas.includes(String(provincia))) {
  return res.status(400).json({
    error: "Código de provincia inválido"
  });
}

if (!/^\d{7,8}$/.test(String(dni))) {
  return res.status(400).json({
    error: "El DNI debe contener 7 u 8 números"
  });
}

    let total = 0;
    const itemsValidados = [];

    for (const item of items) {
      const productId = item.product_id;
      const talle = item.talle;
      const color = item.color || "";
      const cantidad = Number(item.cantidad);

      if (!productId || !talle || !cantidad || cantidad <= 0) {
        return res.status(400).json({ error: "Producto inválido" });
      }

      const { data: producto, error: errorProducto } = await supabase
        .from("products")
        .select("*")
        .eq("id", productId)
        .eq("active", true)
        .single();

      if (errorProducto || !producto) {
        return res.status(400).json({ error: "Producto no encontrado o inactivo" });
      }

      const { data: stock, error: errorStock } = await supabase
        .from("product_stock")
        .select("*")
        .eq("product_id", productId)
.eq("size", talle)
.eq("color", extraerColorBas(color))
.single();

      if (errorStock || !stock) {
        return res.status(400).json({
          error: `No hay stock para ${producto.name} talle ${talle}`
        });
      }

      if (stock.stock < cantidad) {
        return res.status(400).json({
          error: `Stock insuficiente para ${producto.name} talle ${talle}`
        });
      }

      const precioReal = Number(producto.price);
      const subtotal = precioReal * cantidad;
      total += subtotal;

      itemsValidados.push({
        product_id: producto.id,
        product_name: producto.name,
        color,
        size: talle,
        quantity: cantidad,
        unit_price: precioReal,
        subtotal,
coditm: producto.coditm,
bas_size: stock.bas_size
      });
    }

    const { data: intento, error: errorIntento } = await supabase
      .from("checkout_attempts")
      .insert({
        cliente,
        items: itemsValidados,
        total,
        status: "pending"
      })
      .select()
      .single();

    if (errorIntento) {
      console.log("Error creando intento:", errorIntento);
      return res.status(500).json({ error: "Error creando intento de pago" });
    }

    const preference = {
      external_reference: intento.id.toString(),

      items: itemsValidados.map(item => ({
        title: item.product_name,
        quantity: item.quantity,
        currency_id: "ARS",
        unit_price: item.unit_price
      })),

      back_urls: {
        success: `https://usina-rhodia-production.up.railway.app/success.html?attempt_id=${intento.id}`,
        failure: "https://usina-rhodia-production.up.railway.app/failure.html",
        pending: "https://usina-rhodia-production.up.railway.app/pending.html"
      },

      auto_return: "approved"
    };

    const response = await preferenceClient.create({ body: preference });

    res.json({
      id: response.id,
      init_point: response.init_point,
      attempt_id: intento.id
    });

  } catch (error) {
    console.log("ERROR CREAR PREFERENCIA SEGURA:", error);

    res.status(500).json({
      error: "Error creando preferencia segura",
      detalle: error.message || error
    });
  }
});

function crearAdminToken(){
  const payload = {
    role: "admin",
    exp: Date.now() + 1000 * 60 * 60 * 4
  };

  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");

  const firma = crypto
    .createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  return `${payloadBase64}.${firma}`;
}

function verificarAdmin(req, res, next){
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");

  if(!token){
    return res.status(401).json({ error: "No autorizado" });
  }

  const [payloadBase64, firma] = token.split(".");

  const firmaCorrecta = crypto
    .createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  if(firma !== firmaCorrecta){
    return res.status(401).json({ error: "Token inválido" });
  }

  const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString());

  if(Date.now() > payload.exp){
    return res.status(401).json({ error: "Sesión vencida" });
  }

  next();
}

async function getBasToken(){
  const form = new FormData();

  form.append("grant_type", "password");
  form.append("client_id", process.env.BAS_CLIENT_ID);
  form.append("client_secret", process.env.BAS_CLIENT_SECRET);
  form.append("refresh_token", "");
  form.append("username", process.env.BAS_USERNAME);
  form.append("password", process.env.BAS_PASSWORD);

  const response = await fetch(`${process.env.BAS_URL}/auth/token`, {
    method: "POST",
    headers: {
      "accept": "text/plain"
    },
    body: form
  });

  if(!response.ok){
    const text = await response.text();
    throw new Error(`Error BAS token: ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function getAndreaniToken() {
  const username = process.env.ANDREANI_USERNAME;
  const password = process.env.ANDREANI_PASSWORD;
  const baseUrl = process.env.ANDREANI_URL;

  if (!username || !password || !baseUrl) {
    throw new Error("Faltan variables de entorno de Andreani");
  }

  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      userName: username,
      password: password
    })
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Error autenticando con Andreani (${response.status}): ${responseText}`
    );
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    data = responseText;
  }

  const token =
    data?.token ||
    data?.access_token ||
    data?.accessToken ||
    data;

  if (!token || typeof token !== "string") {
    throw new Error(
      `Andreani no devolvió un token válido: ${responseText}`
    );
  }

  return token.trim();
}

function obtenerRegionAndreani(provinciaBas) {
  const regiones = {
    "901": "AR-C",
    "902": "AR-B",
    "903": "AR-K",
    "904": "AR-X",
    "905": "AR-W",
    "906": "AR-H",
    "907": "AR-U",
    "908": "AR-E",
    "909": "AR-P",
    "910": "AR-Y",
    "911": "AR-L",
    "912": "AR-F",
    "913": "AR-M",
    "914": "AR-N",
    "915": "AR-Q",
    "916": "AR-R",
    "917": "AR-A",
    "918": "AR-J",
    "919": "AR-D",
    "920": "AR-Z",
    "921": "AR-S",
    "922": "AR-G",
    "923": "AR-V",
    "924": "AR-T"
  };

  return regiones[String(provinciaBas)] || "AR-B";
}

function separarCalleNumero(direccion) {
  const texto = String(direccion || "").trim();
  const coincidencia = texto.match(/^(.*?)[\s,]+(\d+[a-zA-Z]?)$/);

  if (!coincidencia) {
    return {
      calle: texto,
      numero: "0"
    };
  }

  return {
    calle: coincidencia[1].trim(),
    numero: coincidencia[2].trim()
  };
}

async function crearOrdenAndreani(cliente, pedido, total) {
  const token = await getAndreaniToken();
  const baseUrl = process.env.ANDREANI_URL.replace(/\/+$/, "");

  const domicilio = separarCalleNumero(cliente.direccion);
  const dni = String(cliente.dni || "").replace(/\D/g, "");
  const telefono = String(cliente.telefono || "").replace(/\D/g, "");

  const payload = {
    contrato: process.env.ANDREANI_CONTRATO_DOMICILIO,
    sucursalClienteID: Number(process.env.ANDREANI_SUCURSAL),
    idPedido: `PEDIDO-${pedido.id}`,

    origen: {
      postal: {
        codigoPostal: "1878",
        calle: "Primera Junta",
        numero: "525",
        piso: "",
        departamento: "",
        localidad: "Quilmes",
        region: "AR-B",
        pais: "Argentina"
      }
    },

    destino: {
      postal: {
        codigoPostal: String(cliente.cp),
        calle: domicilio.calle,
        numero: domicilio.numero,
        piso: cliente.depto || "",
        departamento: cliente.depto || "",
        localidad: cliente.ciudad,
        region: obtenerRegionAndreani(cliente.provincia),
        pais: "Argentina"
      }
    },

    remitente: {
      nombreCompleto: "SURPACIFICO SA",
      email: "rodhia@surpacifico.com.ar",
      documentoTipo: "CUIT",
      documentoNumero: "30607219725",
      telefonos: [
        {
          tipo: 1,
          numero: "5491139543761"
        }
      ]
    },

    destinatario: [
      {
        nombreCompleto: `${cliente.nombre} ${cliente.apellido}`,
        email: cliente.email,
        documentoTipo: "DNI",
        documentoNumero: dni,
        telefonos: [
          {
            tipo: 1,
            numero: telefono
          }
        ]
      }
    ],

    remito: {
      numeroRemito: `PEDIDO-${pedido.id}`,
      complementarios: []
    },

    bultos: [
      {
        kilos: 1,
        largoCm: 15,
        altoCm: 10,
        anchoCm: 10,
        volumenCm: 1500,
        valorDeclaradoSinImpuestos: Math.round(Number(total) / 1.21),
        valorDeclaradoConImpuestos: Number(total),
        referencias: [
          {
            meta: "pedido",
            contenido: `Pedido Usina Rhodia #${pedido.id}`
          }
        ],
        descripcion: "Prendas de vestir"
      }
    ],

    pagoPendienteEnMostrador: false
  };

  console.log(
    "Payload orden Andreani:",
    JSON.stringify(payload, null, 2)
  );

  const response = await fetch(`${baseUrl}/v2/ordenes-de-envio`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-authorization-token": token
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    data = responseText;
  }

  if (!response.ok) {
    throw new Error(
      `Error creando orden Andreani (${response.status}): ${responseText}`
    );
  }

  return data;
}

async function obtenerEstadoOrdenAndreani(numeroEnvio) {
  const token = await getAndreaniToken();
  const baseUrl = process.env.ANDREANI_URL.replace(/\/+$/, "");

  if (!numeroEnvio) {
    throw new Error("Falta el número de envío Andreani");
  }

  const response = await fetch(
    `${baseUrl}/v2/ordenes-de-envio/${numeroEnvio}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-authorization-token": token
      }
    }
  );

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    data = responseText;
  }

  if (!response.ok) {
    throw new Error(
      `Error consultando estado Andreani (${response.status}): ${responseText}`
    );
  }

  return data;
}

async function obtenerTrazasAndreani(numeroEnvio) {
  const token = await getAndreaniToken();
  const baseUrl = process.env.ANDREANI_URL.replace(/\/+$/, "");

  if (!numeroEnvio) {
    throw new Error("Falta el número de envío Andreani");
  }

  const response = await fetch(
    `${baseUrl}/v3/envios/${numeroEnvio}/trazas`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-authorization-token": token
      }
    }
  );

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    data = responseText;
  }

  if (!response.ok) {
    throw new Error(
      `Error consultando trazas Andreani (${response.status}): ${responseText}`
    );
  }

  return data;
}

function hoyBas(){
  return new Date().toISOString().slice(0, 10);
}

function talleBas(talle){
  return String(talle || "").trim();
}

function extraerColorBas(color){
  const match = String(color || "").match(/\(([^)]+)\)/);
  return match ? match[1] : color;
}

function calcularImportes(precioFinal, cantidad){
  const total = Number(precioFinal) * Number(cantidad);
  const gravado = Math.round(total / 1.21);
  const iva = total - gravado;

  return { total, gravado, iva };
}

async function buscarClienteBasPorDni(dni){
  const token = await getBasToken();

  const response = await fetch(`${process.env.BAS_URL}/api/CONSULTAGRAL/Cliente`, {
    method: "POST",
    headers: {
      "accept": "text/plain",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      HEADER: {
        ETIQUETA: "CONSULTAGRAL",
        CODEMP: 1,
        CODSUC: 1,
        FECHA: "30-06-2026"
      },
      ConsultaGral: {
        FiltrosAdicionales: [
          {
            TagEntidad: "Cliente",
            NombreCampo: "NumeroImpositivo1",
            Comparacion: "0",
            Valor: dni
          }
        ]
      }
    })
  });

  const data = await response.json();
  return data?.Cuerpo?.CLIENTES?.[0] || null;
}

async function crearClienteBas(cliente){
  const token = await getBasToken();
  const dni = String(cliente.dni).replace(/\D/g, "");
  const nombreCompleto = `${cliente.nombre} ${cliente.apellido}`;

  const payloadClienteBas = {
    Codigo: dni,
    RazonSocial: nombreCompleto,
    Email: cliente.email,
    TratImpositivo: "C08",
    NumeroImpositivoTipo: "95",
    NumeroImpositivo1: dni,
    TodosSuspendidos: false,
    FechaAlta: hoyBas(),
    EmpresaAlta: 1,
    TratImpositivoProv: "C08",
    Fechareg: new Date().toISOString(),

    Contactos: [
      {
        Nombre: nombreCompleto,
        Email: cliente.email,
        Telefono: cliente.telefono,
        Observaciones: "",
        Cheques: false,
        Cobranzas: false,
        Ventas: false,
        EnvioCmp: true
      }
    ],

    CondicionesVenta: [
  {
    Codigo: "001",
    PorDefecto: true,
    ListaEstandar: "LPL"
  }
],

    Domicilios: [
      {
        Descripcion: "Principal",
        Domicilio1: cliente.direccion || "",
        Domicilio2: cliente.depto || "",
        CodigoPostal: cliente.cp || "",
        Localidad: cliente.ciudad || "",
        Provincia: cliente.provincia,
        Pais: "ARG",
        Telefono: cliente.telefono,
        Observaciones: "",
        NroOrden: 1,
        Principal: true,
        Habilitado: true
      }
    ],

    Empresas: [
      {
        Codigo: 1
      }
    ]
  };

  console.log(
    "Payload cliente BAS:",
    JSON.stringify(payloadClienteBas, null, 2)
  );

  const response = await fetch(`${process.env.BAS_URL}/api/Clientes`, {
    method: "POST",
    headers: {
      "accept": "text/plain",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payloadClienteBas)
  });

  const data = await response.json();

  console.log(
    "Respuesta creación cliente BAS:",
    JSON.stringify(data, null, 2)
  );

  if(!response.ok){
    throw new Error(
      "Error creando cliente BAS: " + JSON.stringify(data)
    );
  }

  return data;
}

async function crearFacturaBas(cliente, itemsValidados, total){
  const token = await getBasToken();
  const dni = String(cliente.dni).replace(/\D/g, "");

  const itemsBas = itemsValidados.map(item => {
    const importes = calcularImportes(item.unit_price, item.quantity);

    return {
      CodigoItem: item.coditm,
      Color: extraerColorBas(item.color),
      Talle: item.bas_size,
      PendienteRemitirFacturar: "N",
      NumeroUnidadMedida: "1",
      CantidadPrimeraUnidad: item.quantity,
      PrecioUnitario: item.unit_price,
      PorcentajeBonificacion: 0,
      PorcentajeSegundaBonificacion: 0,
      ImporteTotal: importes.total,
      ImporteGravado: importes.gravado,
      ImporteIva: importes.iva,
      TasaIva: 21,
      Deposito: 14
    };
  });

  const totalGravado = itemsBas.reduce((acc, item) => acc + item.ImporteGravado, 0);
  const totalIva = itemsBas.reduce((acc, item) => acc + item.ImporteIva, 0);

  const payloadFacturaBas = {
  Fecha: hoyBas(),
  Comprobante: "FB",
  Prefijo: "00118",
  Cliente: dni,
  TotalGravado: totalGravado,
  TotalIva: totalIva,
  Total: total,
  MetodoPago: "D",
  ImputacionContable: "640000000",
  Caja: "14W",
  Deposito: 14,
  Empresa: 1,
  Sucursal: 14,
  FechaCreacion: new Date().toISOString(),
  TratImpositivo: "C08",
  TratImpositivoProv: "C08",
  CondicionVentaCompra: "001",
  ObservacionEntrega: "",
  ObservacionComprobante: "Venta ecommerce Usina Rhodia",
  EntregaEn: "",
  Usuario: "MBRAVO",
  Items: itemsBas,
  Efectivos: [
  {
    MedioPago: "MP",
    Importe: total
  }
]
};

console.log("Payload factura BAS:", JSON.stringify(payloadFacturaBas, null, 2));

  const response = await fetch(`${process.env.BAS_URL}/api/ComprobantesVenta?IgnoraAdvertencias=false`, {
    method: "POST",
    headers: {
      "accept": "text/plain",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payloadFacturaBas)
  });

  const data = await response.json();

  if(!response.ok){
    throw new Error("Error creando factura BAS: " + JSON.stringify(data));
  }

  return data;
}

app.post("/admin/login", (req, res) => {
  const { password } = req.body;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      error: "Contraseña incorrecta"
    });
  }

  res.json({
    success: true,
    token: crearAdminToken()
  });
});

app.get("/admin/productos", verificarAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .order("id", { ascending: false });

  if (error) return res.status(400).json({ error });

  res.json({ success: true, productos: data });
});

app.get("/admin/pedidos", verificarAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("orders")
    .select(`
      *,
      order_items (*)
    `)
    .order("id", { ascending: false });

  if (error) return res.status(400).json({ error });

  res.json({ success: true, pedidos: data });
});

app.post("/admin/crear-producto", verificarAdmin, async (req, res) => {
  try {
    const {
      brand,
      name,
      old_price,
      price,
      discount,
      coditm,
      bas_color,
      bas_color_name,
      imageUrls,
      stocks
    } = req.body;

    const { data: producto, error: errorProducto } = await supabase
      .from("products")
      .insert({
        brand,
        name,
        old_price,
        price,
        discount,
        coditm,
        bas_color,
        bas_color_name,
        active: true
      })
      .select()
      .single();

    if (errorProducto) {
      console.log("Error creando producto:", errorProducto);
      return res.status(400).json({ error: "Error creando producto" });
    }

    const imagenesParaInsertar = imageUrls.map((url, index) => ({
      product_id: producto.id,
      image_url: url,
      position: index + 1
    }));

    const { error: errorImagenes } = await supabase
      .from("product_images")
      .insert(imagenesParaInsertar);

    if (errorImagenes) {
      console.log("Error creando imágenes:", errorImagenes);
      return res.status(400).json({ error: "Error creando imágenes" });
    }

    const stockParaInsertar = stocks.map(item => ({
  product_id: producto.id,
  size: item.size,
  bas_size: item.bas_size,
  color: item.color,
  color_name: item.color_name,
  stock: item.stock
}));

    const { error: errorStock } = await supabase
      .from("product_stock")
      .insert(stockParaInsertar);

    if (errorStock) {
      console.log("Error creando stock:", errorStock);
      return res.status(400).json({ error: "Error creando stock" });
    }

    res.json({
      success: true,
      product_id: producto.id
    });

  } catch (error) {
    console.log("Error admin crear producto:", error);
    res.status(500).json({ error: "Error interno creando producto" });
  }
});

app.post("/admin/eliminar-producto", verificarAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Falta ID" });
    }

    await supabase.from("product_stock").delete().eq("product_id", id);
    await supabase.from("product_images").delete().eq("product_id", id);

    const { error } = await supabase
      .from("products")
      .delete()
      .eq("id", id);

    if (error) {
      console.log("Error eliminando producto:", error);
      return res.status(400).json({ error: "Error eliminando producto" });
    }

    res.json({ success: true });
  } catch (error) {
    console.log("Error admin eliminar producto:", error);
    res.status(500).json({ error: "Error interno eliminando producto" });
  }
});

app.post("/admin/desactivar-producto", verificarAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Falta ID" });
    }

    const { error } = await supabase
      .from("products")
      .update({ active: false })
      .eq("id", id);

    if (error) {
      console.log("Error desactivando producto:", error);
      return res.status(400).json({ error: "Error desactivando producto" });
    }

    res.json({ success: true });

  } catch (error) {
    console.log("Error admin desactivar producto:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/admin/cambiar-estado-pedido", verificarAdmin, async (req, res) => {
  try {
    const { id, status } = req.body;

    const estadosPermitidos = [
      "paid",
      "preparado",
      "enviado",
      "entregado",
      "ready_pickup",
      "picked_up"
    ];

    if (!id || !status || !estadosPermitidos.includes(status)) {
      return res.status(400).json({ error: "Datos inválidos" });
    }

    const { error } = await supabase
      .from("orders")
      .update({ status })
      .eq("id", id);

    if (error) {
      console.log("Error cambiando estado:", error);
      return res.status(400).json({ error: "Error cambiando estado" });
    }

    res.json({ success: true });

  } catch (error) {
    console.log("Error admin cambiar estado:", error);
    res.status(500).json({ error: "Error interno cambiando estado" });
  }
});

app.post("/admin/guardar-tracking", verificarAdmin, async (req, res) => {
  try {
    const { id, tracking_code, tracking_url } = req.body;

    if (!id) {
      return res.status(400).json({
        error: "Falta ID"
      });
    }

    const { error } = await supabase
      .from("orders")
      .update({
        tracking_code,
        tracking_url
      })
      .eq("id", id);

    if (error) {
      console.log("Error guardando tracking:", error);
      return res.status(400).json({
        error: "Error guardando tracking"
      });
    }

    res.json({
      success: true
    });

  } catch (error) {
    console.log("Error admin tracking:", error);
    res.status(500).json({
      error: "Error interno"
    });
  }
});

app.get("/order-by-attempt/:attemptId", async (req, res) => {
  try {
    const { attemptId } = req.params;

    const { data: order, error } = await supabase
      .from("orders")
      .select("id, tracking_token, status")
      .eq("checkout_attempt_id", attemptId)
      .single();

    if (error || !order) {
      return res.status(404).json({
        success: false,
        error: "Pedido no encontrado"
      });
    }

    res.json({
      success: true,
      order
    });

  } catch (error) {
    console.log("Error buscando pedido por attempt:", error);
    res.status(500).json({
      success: false,
      error: "Error interno"
    });
  }
});

app.get("/pedido-andreani/:trackingToken", async (req, res) => {
  try {
    const { trackingToken } = req.params;

    if (!trackingToken) {
      return res.status(400).json({
        success: false,
        error: "Falta el token del pedido"
      });
    }

    const { data: pedido, error: errorPedido } = await supabase
      .from("orders")
      .select(`
        id,
        tracking_token,
        andreani_numero_envio,
        andreani_estado
      `)
      .eq("tracking_token", trackingToken)
      .single();

    if (errorPedido || !pedido) {
      return res.status(404).json({
        success: false,
        error: "Pedido no encontrado"
      });
    }

    if (!pedido.andreani_numero_envio) {
      return res.json({
        success: true,
        tieneEnvioAndreani: false
      });
    }

    const [estadoOrden, trazas] = await Promise.all([
      obtenerEstadoOrdenAndreani(pedido.andreani_numero_envio),
      obtenerTrazasAndreani(pedido.andreani_numero_envio)
    ]);

    const eventosOriginales =
      Array.isArray(trazas)
        ? trazas
        : trazas?.eventos || trazas?.trazas || [];

    const eventos = eventosOriginales.map(evento => ({
      fecha:
        evento.fecha ||
        evento.fechaEvento ||
        evento.fechaHora ||
        null,

      estado:
        evento.estado ||
        evento.estadoDescripcion ||
        evento.descripcionEstado ||
        null,

      evento:
        evento.evento ||
        evento.descripcion ||
        evento.descripcionEvento ||
        null,

      motivo:
        evento.motivo ||
        evento.descripcionMotivo ||
        null,

      submotivo:
        evento.submotivo ||
        evento.descripcionSubmotivo ||
        null,

      sucursal:
        evento.sucursal?.descripcion ||
        evento.sucursalDescripcion ||
        evento.sucursal ||
        null,

      comentario:
        evento.comentario ||
        evento.observacion ||
        null
    }));

    const estado =
      estadoOrden?.estado ||
      pedido.andreani_estado ||
      "Sin información";

    const sucursal =
      estadoOrden?.sucursalDeDistribucion?.descripcion || null;

    await supabase
      .from("orders")
      .update({
        andreani_estado: estado
      })
      .eq("id", pedido.id);

    res.json({
      success: true,
      tieneEnvioAndreani: true,
      numeroEnvio: pedido.andreani_numero_envio,
      estado,
      sucursal,
      eventos
    });

  } catch (error) {
    console.log(
      "Error consultando seguimiento Andreani:",
      error.message
    );

    res.status(500).json({
      success: false,
      error: "No se pudo consultar el seguimiento del envío"
    });
  }
});

app.get("/admin/bas-test", verificarAdmin, async (req, res) => {
  try {
    const token = await getBasToken();

    res.json({
      success: true,
      message: "BAS conectado correctamente",
      token_inicio: token.slice(0, 20)
    });

  } catch (error) {
    console.log("Error BAS test:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/admin/andreani-test", verificarAdmin, async (req, res) => {
  try {
    const token = await getAndreaniToken();

    res.json({
      success: true,
      message: "Andreani conectado correctamente",
      token_inicio: token.slice(0, 20)
    });

  } catch (error) {
    console.log("Error Andreani test:", error.message);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/admin/andreani-estado-test/:numeroEnvio", verificarAdmin, async (req, res) => {
  try {
    const { numeroEnvio } = req.params;

    const estado = await obtenerEstadoOrdenAndreani(numeroEnvio);

    res.json({
      success: true,
      estado
    });

  } catch (error) {
    console.log("Error estado Andreani test:", error.message);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


async function obtenerPagoMercadoPago(paymentId){
  for(let intento = 1; intento <= 3; intento++){
    try{
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`
        }
      });

      if(!response.ok){
        const text = await response.text();
        throw new Error(`MercadoPago status ${response.status}: ${text}`);
      }

      return await response.json();

    }catch(error){
      console.log(`Error consultando pago MP intento ${intento}:`, error.message);

      if(intento === 3){
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}

app.post("/webhook", async (req, res) => {
  try {
    console.log("Webhook recibido:", req.body);

    if (req.body.type !== "payment") {
      return res.sendStatus(200);
    }

    const paymentId = req.body.data.id;

    const payment = await obtenerPagoMercadoPago(paymentId);

    console.log("Pago completo:", payment);

    if (payment.status !== "approved") {
      return res.sendStatus(200);
    }

    const attemptId = payment.external_reference;

    console.log("Intento aprobado:", attemptId);

    const { data: intento, error: errorIntento } = await supabase
      .from("checkout_attempts")
      .select("*")
      .eq("id", attemptId)
      .single();

    if (errorIntento || !intento) {
      console.log("No se encontró checkout_attempt:", errorIntento);
      return res.sendStatus(200);
    }

    if (intento.status !== "pending") {
  console.log("Intento ya está siendo procesado o ya fue pagado:", intento.status);
  return res.sendStatus(200);
}

const { data: intentoBloqueado, error: errorBloqueo } = await supabase
  .from("checkout_attempts")
  .update({ status: "processing" })
  .eq("id", attemptId)
  .eq("status", "pending")
  .select("*")
  .single();

if (errorBloqueo || !intentoBloqueado) {
  console.log("Otro webhook ya tomó este intento, no se duplica");
  return res.sendStatus(200);
}

    const cliente = intentoBloqueado.cliente;
const itemsValidados = intentoBloqueado.items;
const total = intentoBloqueado.total;
const trackingToken = crypto.randomUUID();
    const { data: pedido, error: errorPedido } = await supabase
      .from("orders")
      .insert({
        customer_name: cliente.nombre + " " + cliente.apellido,
        customer_email: cliente.email,
        customer_phone: cliente.telefono,
        customer_dni: cliente.dni,
        delivery_method: cliente.entrega,
        address: cliente.direccion || "",
        floor_apartment: cliente.depto || "",
        city: cliente.ciudad || "",
        postal_code: cliente.cp || "",
        total: total,
        status: "paid",
tracking_token: trackingToken,
checkout_attempt_id: intentoBloqueado.id
      })
      .select()
      .single();

    if (errorPedido) {
      console.log("Error creando pedido final:", errorPedido);
      return res.sendStatus(500);
    }

    const itemsParaInsertar = itemsValidados.map(item => ({
      order_id: pedido.id,
      product_id: item.product_id,
      product_name: item.product_name,
      color: item.color,
      size: item.size,
      quantity: item.quantity,
      unit_price: item.unit_price
    }));

    const { error: errorItems } = await supabase
      .from("order_items")
      .insert(itemsParaInsertar);

    if (errorItems) {
      console.log("Error creando items finales:", errorItems);
      return res.sendStatus(500);
    }

    try {
  const dniCliente = String(cliente.dni).replace(/\D/g, "");

  let clienteBas = await buscarClienteBasPorDni(dniCliente);

  if (!clienteBas) {
    await crearClienteBas(cliente);
    clienteBas = await buscarClienteBasPorDni(dniCliente);
  }

  const facturaBas = await crearFacturaBas(cliente, itemsValidados, total);

  const comprobantes = facturaBas?.Comprobantes || [];

const factura = comprobantes.find(c => c.Comprobante === "FAB");
const remito = comprobantes.find(c => c.Comprobante === "REM");
const recibo = comprobantes.find(c => c.Comprobante === "REC.");

await supabase
  .from("orders")
  .update({
    bas_cliente: clienteBas?.Codigo || dniCliente,
    bas_estado: "facturado",
    bas_response: facturaBas,

    bas_factura: factura?.Numero || null,
    bas_remito: remito?.Numero || null,
    bas_recibo: recibo?.Numero || null,
    bas_transaccion: facturaBas?.IdTransaccion || null
  })
  .eq("id", pedido.id);

  console.log("Factura BAS creada:");
console.log(JSON.stringify(facturaBas, null, 2));

} catch (errorBas) {
  console.log("Error integrando BAS:", errorBas.message);

  await supabase
    .from("orders")
    .update({
      bas_estado: "error",
      bas_response: {
        error: errorBas.message
      }
    })
    .eq("id", pedido.id);
}

try {
  const metodoEntrega = String(cliente.entrega || "").toLowerCase();

  const esEnvioDomicilio =
    metodoEntrega.includes("domicilio") ||
    metodoEntrega.includes("envío") ||
    metodoEntrega.includes("envio");

  if (esEnvioDomicilio) {
    const ordenAndreani = await crearOrdenAndreani(
      cliente,
      pedido,
      total
    );

    const numeroEnvio =
      ordenAndreani?.bultos?.[0]?.numeroDeEnvio || null;

    const agrupador =
      ordenAndreani?.agrupadorDeBultos || null;

    const etiquetaUrl =
      ordenAndreani?.etiquetasPorAgrupador || null;

    await supabase
      .from("orders")
      .update({
        andreani_numero_envio: numeroEnvio,
        andreani_agrupador: agrupador,
        andreani_etiqueta_url: etiquetaUrl,
        andreani_estado: ordenAndreani?.estado || "Pendiente",
        andreani_response: ordenAndreani,

        tracking_code: numeroEnvio,
tracking_url: null
      })
      .eq("id", pedido.id);

    console.log(
      `Orden Andreani creada para pedido ${pedido.id}:`,
      numeroEnvio
    );

  } else {
    console.log(
      `Pedido ${pedido.id} sin envío Andreani:`,
      cliente.entrega
    );
  }

} catch (errorAndreani) {
  console.log(
    "Error integrando Andreani:",
    errorAndreani.message
  );

  await supabase
    .from("orders")
    .update({
      andreani_estado: "error",
      andreani_response: {
        error: errorAndreani.message
      }
    })
    .eq("id", pedido.id);
}

    await supabase
      .from("checkout_attempts")
      .update({
        status: "paid"
      })
      .eq("id", attemptId);

    console.log("Pedido final creado:", pedido.id);

    for (const item of itemsValidados) {
      const { data: stockActual, error: errorStock } = await supabase
        .from("product_stock")
        .select("*")
        .eq("product_id", item.product_id)
.eq("size", item.size)
.eq("color", extraerColorBas(item.color))
.single();

      if (errorStock || !stockActual) {
        console.log("No se encontró stock para:", item);
        continue;
      }

      const nuevoStock = stockActual.stock - item.quantity;

      const { error: errorUpdateStock } = await supabase
        .from("product_stock")
        .update({
          stock: nuevoStock < 0 ? 0 : nuevoStock
        })
        .eq("id", stockActual.id);

      if (errorUpdateStock) {
        console.log("Error actualizando stock:", errorUpdateStock);
      } else {
        console.log(
          `Stock actualizado: producto ${item.product_id}, talle ${item.size}, nuevo stock ${nuevoStock}`
        );
      }
    }

    await resend.emails.send({
  from: "USINA RHODIA <compras@mail.usinarhodia.com>",
  to: cliente.email,
  subject: `Compra aprobada #${pedido.id} | Usina Rhodia`,
  html: `
    <div style="
      margin:0;
      padding:30px 16px;
      background:#f3f3f3;
      font-family:Arial,Helvetica,sans-serif;
      color:#171717;
    ">
      <div style="
        max-width:620px;
        margin:0 auto;
        background:#ffffff;
        border-radius:18px;
        overflow:hidden;
        border:1px solid #e5e5e5;
      ">

        <div style="
          background:#111111;
          color:#ffffff;
          padding:24px;
          text-align:center;
        ">
          <div style="
            font-size:24px;
            font-weight:800;
            letter-spacing:2px;
          ">
            USINA RHODIA
          </div>
        </div>

        <div style="padding:30px;">
          <h1 style="
            margin:0 0 18px;
            font-size:28px;
            color:#111111;
          ">
            Pago aprobado
          </h1>

          <p style="font-size:16px;line-height:1.6;margin:0 0 14px;">
            Hola ${cliente.nombre} ${cliente.apellido},
          </p>

          <p style="font-size:16px;line-height:1.6;margin:0 0 14px;">
            Recibimos correctamente el pago de tu compra.
          </p>

          <div style="
            background:#f7f7f7;
            border-radius:12px;
            padding:16px;
            margin:20px 0;
          ">
            <p style="margin:0 0 8px;font-size:15px;">
              <strong>Número de pedido:</strong> #${pedido.id}
            </p>

            <p style="margin:0;font-size:15px;">
              <strong>Total:</strong> $${Number(total).toLocaleString("es-AR")}
            </p>
          </div>

          <p style="font-size:16px;line-height:1.6;margin:0 0 18px;">
            Podés consultar el estado de tu pedido desde el siguiente botón:
          </p>

          <div style="text-align:center;margin:26px 0;">
            <a
              href="https://usina-rhodia-production.up.railway.app/pedido.html?token=${trackingToken}"
              style="
                display:inline-block;
                background:#d71920;
                color:#ffffff;
                padding:15px 24px;
                border-radius:10px;
                text-decoration:none;
                font-weight:bold;
                font-size:15px;
              "
            >
              Ver mi pedido
            </a>
          </div>

          <div style="
            margin-top:28px;
            padding:16px;
            border-left:4px solid #d71920;
            background:#fff7f7;
          ">
            <p style="
              margin:0;
              font-size:14px;
              line-height:1.6;
            ">
              Si necesitás Factura A, escribinos a
              <a
                href="mailto:rodhia@surpacifico.com.ar"
                style="color:#d71920;font-weight:bold;"
              >
                rodhia@surpacifico.com.ar
              </a>
              indicando tu número de pedido y los datos de facturación.
            </p>
          </div>

          <p style="
            margin:28px 0 0;
            font-size:14px;
            color:#666666;
            line-height:1.6;
          ">
            Gracias por comprar en Usina Rhodia.
          </p>
        </div>
      </div>
    </div>
  `
});

    console.log("Mail enviado");

    return res.sendStatus(200);

  } catch (error) {
    console.log("Error webhook:", error);
    return res.sendStatus(500);
  }
});

app.listen(3000, () => {
  console.log("Servidor corriendo en puerto 3000");
});