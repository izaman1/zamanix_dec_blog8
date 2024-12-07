import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { v2 as cloudinary } from 'cloudinary';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import blogRoutes from './routes/blogRoutes.js';
import userRoutes from './routes/userRoutes.js';
import { errorHandler, notFound } from './middleware/errorMiddleware.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// MongoDB Connection with enhanced retry logic
const connectDB = async (retries = 5, delay = 5000) => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      keepAlive: true,
      keepAliveInitialDelay: 300000,
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 30000,
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    return true;
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    if (retries > 0) {
      console.log(`Retrying connection... (${retries} attempts remaining)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return connectDB(retries - 1, delay * 1.5);
    }
    return false;
  }
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check route - MUST be before other routes
app.get('/api/health', async (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  
  // Perform a simple DB operation to verify connection
  let dbOperational = false;
  try {
    await mongoose.connection.db.admin().ping();
    dbOperational = true;
  } catch (error) {
    console.error('Database ping failed:', error);
  }

  const status = dbConnected && dbOperational ? 'healthy' : 'unhealthy';
  const statusCode = status === 'healthy' ? 200 : 503;

  res.status(statusCode).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: {
      connected: dbConnected,
      operational: dbOperational,
      host: mongoose.connection.host,
      state: mongoose.connection.readyState
    },
    environment: process.env.NODE_ENV,
    memory: process.memoryUsage()
  });
});

// Initialize database connection
let dbConnected = false;

const initializeApp = async () => {
  try {
    // Connect to MongoDB
    dbConnected = await connectDB();
    
    if (!dbConnected) {
      throw new Error('Failed to connect to MongoDB after multiple retries');
    }

    // Configure Cloudinary
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    // API Routes
    app.use('/api/blogs', blogRoutes);
    app.use('/api/users', userRoutes);

    // Serve static files in production
    if (process.env.NODE_ENV === 'production') {
      const distPath = path.join(__dirname, '..', 'dist');
      app.use(express.static(distPath));
      
      app.get('*', (req, res, next) => {
        if (req.url.startsWith('/api')) {
          return next();
        }
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }

    // Error Handling
    app.use(notFound);
    app.use(errorHandler);

    // Start server
    const server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log('Shutting down gracefully...');
      try {
        await server.close();
        console.log('Server closed');
        await mongoose.connection.close(false);
        console.log('MongoDB connection closed');
        process.exit(0);
      } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
      }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (err) => {
      console.error('Unhandled Promise Rejection:', err);
      if (process.env.NODE_ENV === 'production') {
        shutdown();
      }
    });

  } catch (error) {
    console.error('Application initialization failed:', error);
    process.exit(1);
  }
};

// Start the application
initializeApp();