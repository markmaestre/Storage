const mongoose = require('mongoose');

const storageStatsSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  totalFiles: {
    type: Number,
    default: 0
  },
  totalFolders: {
    type: Number,
    default: 0
  },
  totalSize: {
    type: Number,
    default: 0
  },
  usedStorage: {
    type: Number,
    default: 0
  },
  fileTypeBreakdown: {
    document: { type: Number, default: 0 },
    image: { type: Number, default: 0 },
    video: { type: Number, default: 0 },
    audio: { type: Number, default: 0 },
    pdf: { type: Number, default: 0 },
    spreadsheet: { type: Number, default: 0 },
    presentation: { type: Number, default: 0 },
    archive: { type: Number, default: 0 },
    text: { type: Number, default: 0 },
    code: { type: Number, default: 0 },
    folder: { type: Number, default: 0 }
  },
  lastCalculated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index
storageStatsSchema.index({ userId: 1 });

// Method to update stats
storageStatsSchema.statics.updateUserStats = async function(userId) {
  try {
    const File = mongoose.model('File');
    
    // Convert userId to ObjectId properly
    const userObjectId = new mongoose.Types.ObjectId(userId);
    
    // Get file type breakdown (including folders)
    const fileStats = await File.aggregate([
      { 
        $match: { 
          userId: userObjectId, 
          inTrash: false 
        } 
      },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          totalSize: { $sum: '$size' }
        }
      }
    ]);

    // Get separate counts for files and folders
    const counts = await File.aggregate([
      { 
        $match: { 
          userId: userObjectId, 
          inTrash: false 
        } 
      },
      {
        $group: {
          _id: null,
          totalFiles: { 
            $sum: { 
              $cond: [{ $eq: ['$isFolder', false] }, 1, 0] 
            } 
          },
          totalFolders: { 
            $sum: { 
              $cond: [{ $eq: ['$isFolder', true] }, 1, 0] 
            } 
          },
          totalSize: { $sum: '$size' }
        }
      }
    ]);

    // Initialize file type breakdown
    const fileTypeBreakdown = {
      document: 0,
      image: 0,
      video: 0,
      audio: 0,
      pdf: 0,
      spreadsheet: 0,
      presentation: 0,
      archive: 0,
      text: 0,
      code: 0,
      folder: 0
    };

    let totalSize = 0;

    // Populate file type breakdown
    fileStats.forEach(stat => {
      if (fileTypeBreakdown.hasOwnProperty(stat._id)) {
        fileTypeBreakdown[stat._id] = stat.count;
      }
      totalSize += stat.totalSize;
    });

    const totalFiles = counts[0]?.totalFiles || 0;
    const totalFolders = counts[0]?.totalFolders || 0;
    const calculatedTotalSize = counts[0]?.totalSize || 0;

    // Update storage stats
    const result = await this.findOneAndUpdate(
      { userId: userObjectId },
      {
        totalFiles,
        totalFolders,
        totalSize: calculatedTotalSize,
        usedStorage: calculatedTotalSize,
        fileTypeBreakdown,
        lastCalculated: new Date()
      },
      { upsert: true, new: true }
    );

    console.log(`Updated stats for user ${userId}:`, {
      totalFiles,
      totalFolders,
      totalSize: calculatedTotalSize,
      fileTypeBreakdown
    });

    return { 
      totalFiles, 
      totalFolders, 
      totalSize: calculatedTotalSize, 
      fileTypeBreakdown 
    };
  } catch (error) {
    console.error('Error updating storage stats:', error);
    throw error;
  }
};

// Method to get storage overview
storageStatsSchema.statics.getStorageOverview = async function(userId) {
  try {
    const stats = await this.findOne({ userId });
    
    if (!stats) {
      // If no stats exist, create them
      return await this.updateUserStats(userId);
    }

    return {
      total: {
        used: stats.usedStorage,
        available: 16106127360, // 15GB in bytes
        fileCount: stats.totalFiles,
        folderCount: stats.totalFolders
      },
      byType: stats.fileTypeBreakdown
    };
  } catch (error) {
    console.error('Error getting storage overview:', error);
    throw error;
  }
};

module.exports = mongoose.models.StorageStats || mongoose.model('StorageStats', storageStatsSchema);