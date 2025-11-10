const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const File = require('../models/File');
const Activity = require('../models/Activity');
const StorageStats = require('../models/StorageStats');
const User = require('../models/User');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const userUploadDir = path.join(__dirname, '../uploads', req.user._id.toString());
    // Create user-specific upload directory if it doesn't exist
    if (!fs.existsSync(userUploadDir)) {
      fs.mkdirSync(userUploadDir, { recursive: true });
    }
    cb(null, userUploadDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename while preserving extension
    const fileExt = path.extname(file.originalname);
    const fileName = path.basename(file.originalname, fileExt);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, fileName + '-' + uniqueSuffix + fileExt);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: function (req, file, cb) {
    // Accept all file types
    cb(null, true);
  }
});

// Get user files
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { folder, type, search, sort = 'updatedAt', order = 'desc' } = req.query;
    
    let query = { 
      userId: req.user._id, 
      inTrash: false 
    };

    if (folder) {
      query.parentFolder = folder === 'root' ? null : folder;
    }

    if (type && type !== 'all') {
      query.type = type;
    }

    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    const sortOrder = order === 'desc' ? -1 : 1;
    const files = await File.find(query)
      .sort({ [sort]: sortOrder })
      .populate('sharedWith.user', 'username email')
      .lean();

    // Log view activity
    await Activity.logActivity({
      type: 'view',
      userId: req.user._id,
      fileName: 'Multiple Files',
      details: new Map([['action', 'list_files'], ['folder', folder || 'root']])
    });

    res.json({
      success: true,
      files: files.map(file => ({
        id: file._id,
        name: file.name,
        type: file.type,
        size: file.size,
        uploadDate: file.createdAt,
        updatedAt: file.updatedAt,
        uploader: req.user.username,
        uploaderEmail: req.user.email,
        url: `/api/files/${file._id}/download`,
        sharedWith: file.sharedWith,
        isFolder: file.isFolder
      }))
    });
  } catch (error) {
    console.error('Get files error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while fetching files'
    });
  }
});

// Get recent activities
router.get('/recent', authMiddleware, async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    
    const activities = await Activity.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .populate('fileId', 'name type')
      .populate('targetUserId', 'username email')
      .lean();

    const formattedActivities = activities.map(activity => ({
      id: activity._id,
      type: activity.type,
      fileName: activity.fileName,
      description: getActivityDescription(activity),
      timestamp: activity.createdAt,
      icon: getActivityIcon(activity.type),
      file: activity.fileId
    }));

    res.json({
      success: true,
      activities: formattedActivities
    });
  } catch (error) {
    console.error('Get recent activities error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while fetching recent activities'
    });
  }
});

// Get shared files
router.get('/shared', authMiddleware, async (req, res) => {
  try {
    const sharedFiles = await File.find({
      'sharedWith.user': req.user._id,
      inTrash: false
    })
    .populate('userId', 'username email')
    .populate('sharedWith.user', 'username email')
    .sort({ updatedAt: -1 })
    .lean();

    const formattedFiles = sharedFiles.map(file => {
      const shareInfo = file.sharedWith.find(share => 
        share.user._id.toString() === req.user._id.toString()
      );
      
      return {
        id: file._id,
        name: file.name,
        type: file.type,
        size: file.size,
        uploadDate: file.createdAt,
        sharedBy: file.userId.username,
        sharedByEmail: file.userId.email,
        sharedAt: shareInfo.sharedAt,
        permission: shareInfo.permission,
        url: `/api/files/${file._id}/download`,
        canEdit: shareInfo.permission === 'edit'
      };
    });

    res.json({
      success: true,
      files: formattedFiles
    });
  } catch (error) {
    console.error('Get shared files error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while fetching shared files'
    });
  }
});

// Get trash files
router.get('/trash', authMiddleware, async (req, res) => {
  try {
    const trashFiles = await File.find({
      userId: req.user._id,
      inTrash: true
    })
    .sort({ deletedAt: -1 })
    .lean();

    res.json({
      success: true,
      files: trashFiles.map(file => ({
        id: file._id,
        name: file.name,
        type: file.type,
        size: file.size,
        uploadDate: file.createdAt,
        deletedAt: file.deletedAt,
        url: `/api/files/${file._id}/download`
      }))
    });
  } catch (error) {
    console.error('Get trash files error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while fetching trash files'
    });
  }
});

// Upload file
router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    console.log('Upload request received:', req.file);
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const { originalname, mimetype, size, filename, path: filePath } = req.file;

    // Check storage limit (15GB = 16106127360 bytes)
    const storageStats = await StorageStats.findOne({ userId: req.user._id });
    if (storageStats && (storageStats.usedStorage + size) > 16106127360) {
      // Delete the uploaded file
      fs.unlinkSync(filePath);
      return res.status(400).json({
        success: false,
        error: 'Storage limit exceeded. Please upgrade your plan or free up space.'
      });
    }

    const fileType = getFileTypeFromMime(mimetype);

    const newFile = new File({
      name: originalname,
      originalName: originalname,
      type: fileType,
      size: size,
      path: filePath,
      userId: req.user._id,
      parentFolder: null, // root folder
      isFolder: false,
      metadata: new Map([['uploadMethod', 'multer'], ['mimetype', mimetype]])
    });

    await newFile.save();

    // Update storage stats
    await StorageStats.updateUserStats(req.user._id);

    // Log activity
    await Activity.logActivity({
      type: 'upload',
      fileId: newFile._id,
      fileName: originalname,
      userId: req.user._id,
      details: new Map([['size', size.toString()], ['type', fileType]])
    });

    res.status(201).json({
      success: true,
      message: 'File uploaded successfully',
      file: {
        id: newFile._id,
        name: newFile.name,
        type: newFile.type,
        size: newFile.size,
        uploadDate: newFile.createdAt,
        uploader: req.user.username,
        uploaderEmail: req.user.email,
        url: `/api/files/${newFile._id}/download`
      }
    });
  } catch (error) {
    console.error('Upload file error:', error);
    
    // Clean up uploaded file if error occurred
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
    
    res.status(500).json({
      success: false,
      error: 'Server error while uploading file'
    });
  }
});

// Download file
router.get('/:fileId/download', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;
    
    const file = await File.findOne({ 
      _id: fileId,
      $or: [
        { userId: req.user._id },
        { 'sharedWith.user': req.user._id }
      ]
    });

    if (!file) {
      return res.status(404).json({
        success: false,
        error: 'File not found or access denied'
      });
    }

    if (!fs.existsSync(file.path)) {
      return res.status(404).json({
        success: false,
        error: 'File not found on server'
      });
    }

    // Log download activity
    await Activity.logActivity({
      type: 'download',
      fileId: file._id,
      fileName: file.name,
      userId: req.user._id
    });

    res.setHeader('Content-Disposition', `attachment; filename="${file.originalName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    const fileStream = fs.createReadStream(file.path);
    fileStream.pipe(res);

  } catch (error) {
    console.error('Download file error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while downloading file'
    });
  }
});

// Share file
router.post('/:fileId/share', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { targetUserEmail, permission = 'view' } = req.body;

    if (!targetUserEmail) {
      return res.status(400).json({
        success: false,
        error: 'Target user email is required'
      });
    }

    // Find target user
    const targetUser = await User.findOne({ email: targetUserEmail.toLowerCase() });
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check if trying to share with self
    if (targetUser._id.toString() === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        error: 'Cannot share file with yourself'
      });
    }

    const file = await File.findOne({ _id: fileId, userId: req.user._id });
    if (!file) {
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }

    // Check if already shared
    const alreadyShared = file.sharedWith.some(share => 
      share.user.toString() === targetUser._id.toString()
    );

    if (alreadyShared) {
      return res.status(400).json({
        success: false,
        error: 'File already shared with this user'
      });
    }

    file.sharedWith.push({
      user: targetUser._id,
      permission,
      sharedAt: new Date()
    });

    await file.save();

    // Log activity
    await Activity.logActivity({
      type: 'share',
      fileId: file._id,
      fileName: file.name,
      userId: req.user._id,
      targetUserId: targetUser._id,
      details: new Map([['permission', permission]])
    });

    res.json({
      success: true,
      message: `File shared successfully with ${targetUserEmail}`
    });
  } catch (error) {
    console.error('Share file error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while sharing file'
    });
  }
});

// Move file to trash
router.post('/:fileId/trash', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;

    const file = await File.findOne({ _id: fileId, userId: req.user._id });
    if (!file) {
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }

    file.inTrash = true;
    file.deletedAt = new Date();
    file.permanentDeleteAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await file.save();

    // Update storage stats
    await StorageStats.updateUserStats(req.user._id);

    // Log activity
    await Activity.logActivity({
      type: 'delete',
      fileId: file._id,
      fileName: file.name,
      userId: req.user._id
    });

    res.json({
      success: true,
      message: 'File moved to trash'
    });
  } catch (error) {
    console.error('Move to trash error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while moving file to trash'
    });
  }
});

// Restore file from trash
router.post('/:fileId/restore', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;

    const file = await File.findOne({ _id: fileId, userId: req.user._id, inTrash: true });
    if (!file) {
      return res.status(404).json({
        success: false,
        error: 'File not found in trash'
      });
    }

    file.inTrash = false;
    file.deletedAt = null;
    file.permanentDeleteAt = null;

    await file.save();

    // Update storage stats
    await StorageStats.updateUserStats(req.user._id);

    // Log activity
    await Activity.logActivity({
      type: 'restore',
      fileId: file._id,
      fileName: file.name,
      userId: req.user._id
    });

    res.json({
      success: true,
      message: 'File restored successfully'
    });
  } catch (error) {
    console.error('Restore file error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while restoring file'
    });
  }
});

// Delete file permanently
router.delete('/:fileId', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;

    const file = await File.findOne({ _id: fileId, userId: req.user._id });
    if (!file) {
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }

    // Delete physical file
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    await File.findByIdAndDelete(fileId);

    // Update storage stats
    await StorageStats.updateUserStats(req.user._id);

    res.json({
      success: true,
      message: 'File permanently deleted'
    });
  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while deleting file'
    });
  }
});

// Empty trash
router.delete('/trash/empty', authMiddleware, async (req, res) => {
  try {
    const trashFiles = await File.find({ 
      userId: req.user._id, 
      inTrash: true 
    });

    // Delete physical files
    for (const file of trashFiles) {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    }

    // Delete from database
    await File.deleteMany({ 
      userId: req.user._id, 
      inTrash: true 
    });

    // Update storage stats
    await StorageStats.updateUserStats(req.user._id);

    res.json({
      success: true,
      message: 'Trash emptied successfully',
      deletedCount: trashFiles.length
    });
  } catch (error) {
    console.error('Empty trash error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while emptying trash'
    });
  }
});

// Get file info
router.get('/:fileId/info', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;
    
    const file = await File.findOne({ 
      _id: fileId,
      $or: [
        { userId: req.user._id },
        { 'sharedWith.user': req.user._id }
      ]
    }).populate('sharedWith.user', 'username email');

    if (!file) {
      return res.status(404).json({
        success: false,
        error: 'File not found or access denied'
      });
    }

    res.json({
      success: true,
      file: {
        id: file._id,
        name: file.name,
        type: file.type,
        size: file.size,
        uploadDate: file.createdAt,
        updatedAt: file.updatedAt,
        uploader: req.user.username,
        sharedWith: file.sharedWith,
        isFolder: file.isFolder,
        inTrash: file.inTrash,
        url: `/api/files/${file._id}/download`
      }
    });
  } catch (error) {
    console.error('Get file info error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while fetching file info'
    });
  }
});

// Helper functions
function getActivityDescription(activity) {
  const descriptions = {
    upload: `You uploaded ${activity.fileName}`,
    download: `You downloaded ${activity.fileName}`,
    view: `You viewed ${activity.fileName}`,
    share: `You shared ${activity.fileName} with ${activity.targetUserId?.username || 'another user'}`,
    rename: `You renamed a file to ${activity.fileName}`,
    move: `You moved ${activity.fileName}`,
    delete: `You deleted ${activity.fileName}`,
    restore: `You restored ${activity.fileName}`,
    create_folder: `You created folder ${activity.fileName}`
  };
  return descriptions[activity.type] || `You performed ${activity.type} on ${activity.fileName}`;
}

function getActivityIcon(type) {
  const icons = {
    upload: 'file_upload',
    download: 'download',
    view: 'visibility',
    share: 'share',
    rename: 'drive_file_rename_outline',
    move: 'drive_file_move',
    delete: 'delete',
    restore: 'restore',
    create_folder: 'create_new_folder'
  };
  return icons[type] || 'description';
}

function getFileTypeFromMime(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('pdf')) return 'pdf';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'document';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'spreadsheet';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'presentation';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('7z')) return 'archive';
  if (mimeType.includes('text') || mimeType.includes('plain')) return 'text';
  if (mimeType.includes('javascript') || mimeType.includes('python') || mimeType.includes('java') || 
      mimeType.includes('cpp') || mimeType.includes('html') || mimeType.includes('css')) return 'code';
  return 'document';
}

module.exports = router;