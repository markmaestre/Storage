const express = require('express');
const mongoose = require('mongoose');
const File = require('../models/File');
const Activity = require('../models/Activity');
const StorageStats = require('../models/StorageStats');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

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
        ...file,
        url: `/api/files/${file._id}/download`
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
        ...file,
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
        ...file,
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
router.post('/upload', authMiddleware, async (req, res) => {
  try {
    const { name, type, size, content, parentFolder = null } = req.body;

    if (!name || !type || !size) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Check storage limit (15GB = 16106127360 bytes)
    const storageStats = await StorageStats.findOne({ userId: req.user._id });
    if (storageStats && (storageStats.usedStorage + size) > 16106127360) {
      return res.status(400).json({
        success: false,
        error: 'Storage limit exceeded. Please upgrade your plan or free up space.'
      });
    }

    const newFile = new File({
      name,
      originalName: name,
      type,
      size,
      path: `uploads/${req.user._id}/${Date.now()}_${name}`,
      userId: req.user._id,
      parentFolder: parentFolder === 'root' ? null : parentFolder,
      isFolder: false,
      metadata: new Map([['uploadMethod', 'direct']])
    });

    await newFile.save();

    // Update storage stats
    await StorageStats.updateUserStats(req.user._id);

    // Log activity
    await Activity.logActivity({
      type: 'upload',
      fileId: newFile._id,
      fileName: name,
      userId: req.user._id,
      details: new Map([['size', size.toString()], ['type', type]])
    });

    res.status(201).json({
      success: true,
      message: 'File uploaded successfully',
      file: {
        ...newFile.toObject(),
        url: `/api/files/${newFile._id}/download`
      }
    });
  } catch (error) {
    console.error('Upload file error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while uploading file'
    });
  }
});

// Share file
router.post('/:fileId/share', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { targetUserId, permission = 'view' } = req.body;

    const file = await File.findOne({ _id: fileId, userId: req.user._id });
    if (!file) {
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }

    // Check if already shared
    const alreadyShared = file.sharedWith.some(share => 
      share.user.toString() === targetUserId
    );

    if (alreadyShared) {
      return res.status(400).json({
        success: false,
        error: 'File already shared with this user'
      });
    }

    file.sharedWith.push({
      user: targetUserId,
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
      targetUserId,
      details: new Map([['permission', permission]])
    });

    res.json({
      success: true,
      message: 'File shared successfully'
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
    await File.deleteMany({ 
      userId: req.user._id, 
      inTrash: true 
    });

    // Update storage stats
    await StorageStats.updateUserStats(req.user._id);

    res.json({
      success: true,
      message: 'Trash emptied successfully'
    });
  } catch (error) {
    console.error('Empty trash error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while emptying trash'
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

module.exports = router;